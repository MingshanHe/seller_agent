// 审批通过后的提交动作。提交前再按代码规则检查一遍，模型和卡片内容都绕不过去。
import type { Store } from '../db.ts';
import { minPriceFor, type PricingConfig } from '../pricing/engine.ts';
import type { FxProvider } from '../pricing/fx.ts';
import { isTransient, type TikTokClient } from '../tiktok/client.ts';
import { buildGlobalProduct, buildLocalProduct, buildPublishGlobal } from '../tiktok/payload.ts';
import type { ActionRow, ListingDraft, Shop } from '../types.ts';
import { contactHits, simplifiedChineseHits } from './screen.ts';

export interface PublishDeps {
  store: Store;
  tiktok: TikTokClient;
  fx: FxProvider;
  pricing: PricingConfig;
  now?: () => number;
}

const MAX_DRAFT_AGE_MS = 3 * 86400_000;

export function assertPublishable(draft: ListingDraft, force: boolean, c: PricingConfig, now = Date.now()) {
  if (draft.risk === 'block') throw new Error('草稿被风险规则拦截');
  if (now - draft.createdAt > MAX_DRAFT_AGE_MS) throw new Error('草稿超过 3 天，汇率和行情可能已变，请重新发送链接');
  if (draft.listingRoute === 'local' && !draft.check.passed) {
    throw new Error(`官方检查没有通过：${draft.check.failReasons.join('；')}`);
  }
  if (draft.pricing.decision === 'reject' && !force) throw new Error('定价结果是建议放弃，需要明确选择“仍然提交”');
  for (const sku of draft.skus) {
    const priced = draft.pricing.skus.find((s) => s.sourceSkuId === sku.sourceSkuId);
    if (!priced) throw new Error(`SKU ${sku.sellerSku} 没有定价记录`);
    const floor = Math.max(priced.floorJpy, minPriceFor(sku.priceJpy, priced.fixedCostJpy, draft.pricing.commissionRate, c));
    if (sku.priceJpy < floor) throw new Error(`SKU ${sku.sellerSku} 售价低于底线价 ¥${floor}`);
    if (sku.priceJpy < c.limits.minPriceJpy || sku.priceJpy > c.limits.maxPriceJpy) {
      throw new Error(`SKU ${sku.sellerSku} 售价超出日本站范围`);
    }
  }
  const text = [
    draft.content.title,
    ...draft.content.descriptionParagraphs,
    ...draft.skus.flatMap((s) => s.specs.flatMap((x) => [x.name, x.value])),
  ].join('\n');
  const chinese = simplifiedChineseHits(text);
  if (chinese.length > 0) throw new Error(`文案含中文字：${chinese.join('')}`);
  const contact = contactHits(text);
  if (contact.length > 0) throw new Error(`文案含站外联系方式：${contact.join('、')}`);
  if (draft.content.title.length > 255) throw new Error('标题超过 255 字符');
}

/** 先存货源对应关系。提交中途崩溃时，订单仍然能找回货源。 */
export function saveMappings(store: Store, draft: ListingDraft, shop: Pick<Shop, 'id'>, productId: string | null, skuIds: Map<string, string>) {
  for (const sku of draft.skus) {
    const priced = draft.pricing.skus.find((s) => s.sourceSkuId === sku.sourceSkuId)!;
    store.saveSkuMapping({
      sellerSku: sku.sellerSku,
      shopId: shop.id,
      draftId: draft.id,
      sourceUrl: draft.source.url,
      specText: draft.source.skus.find((s) => s.sourceSkuId === sku.sourceSkuId)!.specs.map((s) => `${s.name}：${s.value}`).join('，'),
      purchaseCny: sku.purchaseCny,
      fixedCostJpy: priced.fixedCostJpy,
      commissionRate: draft.pricing.commissionRate,
      productId,
      skuId: skuIds.get(sku.sellerSku) ?? null,
      warehouseId: draft.warehouseId,
    });
  }
}

async function publishGlobal(deps: PublishDeps, shop: Shop, draft: ListingDraft): Promise<string> {
  const usdJpy = await deps.fx.rate('USD/JPY');
  const created = await deps.tiktok.createGlobalProduct(shop, buildGlobalProduct(draft, usdJpy));
  const orphan = `全球商品 ${created.globalProductId} 已创建，但没有发布到日本`;
  let published: any;
  try {
    published = await deps.tiktok.publishGlobalProduct(shop, created.globalProductId, buildPublishGlobal(draft, created.globalSkus));
  } catch (err) {
    throw new Error(`${orphan}：${(err as Error).message}`);
  }
  const jp = (published.publish_result ?? []).find((p: any) => p.region === 'JP');
  if (jp?.status !== 'SUCCESS') {
    throw new Error(`${orphan}（状态 ${jp?.status ?? '未知'}）：${JSON.stringify(jp?.fail_reasons ?? [])}`);
  }
  const productId = (published.products ?? []).find((p: any) => p.region === 'JP')?.id;
  if (!productId) throw new Error(`${orphan}：回执里没有日本商品 ID`);
  return productId;
}

export function publishExecutor(deps: PublishDeps) {
  return async (action: ActionRow) => {
    const { draftId, force } = action.payload as { draftId: string; force?: boolean };
    const draft = deps.store.draft(draftId);
    if (!draft) throw new Error('草稿不存在');
    const shop = deps.store.shop(draft.shopId);
    if (!shop) throw new Error('店铺未授权');
    assertPublishable(draft, Boolean(force), deps.pricing, (deps.now ?? Date.now)());

    saveMappings(deps.store, draft, shop, null, new Map());
    try {
      let productId: string;
      let skuIds = new Map<string, string>();
      if (draft.listingRoute === 'local') {
        const r = await deps.tiktok.createProduct(shop, {
          ...buildLocalProduct(draft),
          save_mode: 'LISTING',
          idempotency_key: draft.id,
        });
        productId = r.productId;
        skuIds = new Map(r.skus.map((s) => [s.seller_sku, s.id]));
      } else {
        productId = await publishGlobal(deps, shop, draft);
      }
      saveMappings(deps.store, draft, shop, productId, skuIds);
      deps.store.setDraftStatus(draft.id, 'submitted');
      return { productId };
    } catch (err) {
      deps.store.setDraftStatus(draft.id, 'failed');
      if (isTransient(err)) {
        throw new Error(`网络或平台错误，商品可能已经提交，请先到店铺后台确认，不要重复上架：${(err as Error).message}`);
      }
      throw err;
    }
  };
}

export function deactivateExecutor(deps: Pick<PublishDeps, 'store' | 'tiktok'>) {
  return async (action: ActionRow) => {
    const { productId } = action.payload as { productId: string };
    const shop = deps.store.shop(action.shopId);
    if (!shop) throw new Error('店铺未授权');
    await deps.tiktok.deactivateProduct(shop, productId);
    return { productId };
  };
}
