// 链接上架的主流程：把货源变成一份待审批的草稿。这里不会发布任何东西。
import { randomUUID } from 'node:crypto';
import { priceProduct, type PricingConfig } from '../pricing/engine.ts';
import { marketStats, searchMarket, type MarketKeys } from '../pricing/market.ts';
import type { FxProvider } from '../pricing/fx.ts';
import type { TikTokClient } from '../tiktok/client.ts';
import { buildLocalProduct, descriptionHtml } from '../tiktok/payload.ts';
import type { Claude } from '../llm/claude.ts';
import type { FetchLike, Dimensions, DraftImage, DraftSku, JaContent, ListingDraft, RiskFlag, Shop, SourceProduct } from '../types.ts';
import { chooseImages, fillAttributes, localize, matchComparables } from './llm.ts';
import { downloadImage, type ImageTranslator } from './images.ts';
import { contactHits, overallRisk, screenSource, simplifiedChineseHits } from './screen.ts';

export interface PipelineDeps {
  tiktok: TikTokClient;
  claude: Claude;
  translator: ImageTranslator | null;
  fx: FxProvider;
  fetchImpl: FetchLike;
  marketKeys: MarketKeys;
  pricing: PricingConfig;
}

export class ListingBlocked extends Error {
  reasons: string[];
  constructor(reasons: string[]) {
    super(reasons.join('；'));
    this.name = 'ListingBlocked';
    this.reasons = reasons;
  }
}

const DEFAULT_WEIGHT = 500;
const DEFAULT_DIMS: Dimensions = { l: 20, w: 15, h: 10 };

function hasPlaceholderPrice(source: SourceProduct): boolean {
  return source.skus.some((s) => !(s.priceCny > 0));
}

function contentText(c: JaContent): string {
  return [
    c.title,
    ...c.descriptionParagraphs,
    ...c.salesAttributes.flatMap((a) => [a.name, ...a.values.map((v) => v.ja)]),
  ].join('\n');
}

function contentProblems(c: JaContent): string[] {
  const text = contentText(c);
  const problems: string[] = [];
  const chinese = simplifiedChineseHits(text);
  if (chinese.length > 0) problems.push(`还有中文字：${chinese.join('')}`);
  const contact = contactHits(text);
  if (contact.length > 0) problems.push(`含站外联系方式：${contact.join('、')}`);
  return problems;
}

export async function localizeChecked(deps: Pick<PipelineDeps, 'claude'>, source: SourceProduct, notes: string[]): Promise<JaContent> {
  let content = await localize(deps.claude, source);
  let problems = contentProblems(content);
  if (problems.length > 0) {
    content = await localize(deps.claude, source, `上一版有问题：${problems.join('；')}。请全部用日语重写，删除这些内容。`);
    problems = contentProblems(content);
    for (const p of problems) notes.push(`文案${p}，提交时会被拦下，请重新生成`);
  }
  return content;
}

export interface CollectedImage {
  bytes: Uint8Array;
  sourceUrl: string;
  previewUrl: string;
  translated: boolean;
}

/** 选图、翻译、下载。两种模式共用。 */
export async function collectImages(deps: Omit<PipelineDeps, 'tiktok'>, source: SourceProduct, notes: string[]): Promise<CollectedImage[]> {
  if (source.images.length === 0) return [];
  let picks: { url: string; hasChineseText: boolean }[];
  try {
    picks = await chooseImages(deps.claude, source.images);
  } catch (err) {
    notes.push(`自动选图失败，改用前 9 张：${(err as Error).message}`);
    picks = source.images.slice(0, 9).map((url) => ({ url, hasChineseText: false }));
  }

  const images: CollectedImage[] = [];
  for (const [i, pick] of picks.entries()) {
    let url = pick.url;
    let translated = false;
    if (pick.hasChineseText) {
      if (deps.translator) {
        try {
          const out = await deps.translator.translate(pick.url);
          if (out) { url = out; translated = true; }
        } catch (err) {
          notes.push(`第 ${i + 1} 张图翻译失败：${(err as Error).message}`);
        }
      }
      if (!translated) notes.push(`第 ${i + 1} 张图保留了中文，请检查`);
    }
    try {
      const bytes = await downloadImage(deps.fetchImpl, url, { translatorResult: translated });
      images.push({ bytes, sourceUrl: pick.url, previewUrl: url, translated });
    } catch (err) {
      notes.push(`第 ${i + 1} 张图下载失败：${(err as Error).message}`);
    }
  }
  return images;
}

async function uploadImages(deps: PipelineDeps, shop: Shop, collected: CollectedImage[], notes: string[]): Promise<DraftImage[]> {
  const images: DraftImage[] = [];
  for (const [i, image] of collected.entries()) {
    try {
      const uri = await deps.tiktok.uploadImage(shop, image.bytes, `image-${i + 1}.jpg`);
      images.push({ uri, sourceUrl: image.sourceUrl, previewUrl: image.previewUrl, translated: image.translated });
    } catch (err) {
      notes.push(`第 ${i + 1} 张图上传失败：${(err as Error).message}`);
    }
  }
  return images;
}

/** 全球商品的规格值只能用字母和数字，同一规格下不能重复。 */
function asciiNames(content: JaContent): Map<string, string> {
  const out = new Map<string, string>();
  for (const attr of content.salesAttributes) {
    const used = new Set<string>();
    attr.values.forEach((v, i) => {
      let name = v.en.replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, 40) || `Option ${i + 1}`;
      if (used.has(name.toLowerCase())) name = `${name} ${i + 1}`;
      used.add(name.toLowerCase());
      out.set(`${attr.sourceName}\u0000${v.source}`, name);
    });
  }
  return out;
}

export function buildSkus(draftId: string, source: SourceProduct, content: JaContent, prices: Map<string, number>, stock: number): DraftSku[] {
  const attrs = new Map(content.salesAttributes.map((a) => [a.sourceName, a]));
  const ascii = asciiNames(content);
  return source.skus.map((sku, i) => ({
    sellerSku: `${draftId.slice(0, 8)}-${i + 1}`,
    sourceSkuId: sku.sourceSkuId,
    purchaseCny: sku.priceCny,
    priceJpy: prices.get(sku.sourceSkuId)!,
    stock,
    specs: sku.specs.map((s) => {
      const attr = attrs.get(s.name);
      const value = attr?.values.find((v) => v.source === s.value)?.ja;
      return {
        name: attr?.name ?? s.name,
        value: value ?? s.value,
        ascii: ascii.get(`${s.name}\u0000${s.value}`) ?? `Option ${i + 1}`,
      };
    }),
  }));
}

/** 两种模式共用的筛查：不合规的货源在调用模型写文案前就停下。 */
export function precheck(source: SourceProduct): RiskFlag[] {
  if (source.images.length === 0) throw new ListingBlocked(['没有商品图。截图模式读不到图片，请用插件取数']);
  if (source.skus.length === 0) throw new ListingBlocked(['没有读到规格和价格']);
  if (hasPlaceholderPrice(source)) throw new ListingBlocked(['有规格没有读到价格']);
  if (source.skus.length > 300) throw new ListingBlocked(['规格超过 300 个']);

  const flags: RiskFlag[] = screenSource(source);
  if (overallRisk(flags) === 'block') throw new ListingBlocked(flags.filter((f) => f.level === 'block').map((f) => f.reason));
  for (const p of source.unverifiedPrices ?? []) {
    flags.push({ level: 'review', reason: `价格在页面文字里找不到，请核对：${p}` });
  }
  return flags;
}

export function assertContentSafe(content: JaContent) {
  if (overallRisk(content.riskFlags) === 'block') {
    throw new ListingBlocked(content.riskFlags.filter((f) => f.level === 'block').map((f) => f.reason));
  }
}

export function resolveSize(source: SourceProduct, content: JaContent, notes: string[]): { weightGrams: number; dimensionsCm: Dimensions } {
  let weightGrams = source.weightGrams ?? content.estimatedWeightGrams;
  if (!source.weightGrams) notes.push('重量是估算值，会影响运费和定价');
  if (!weightGrams) { weightGrams = DEFAULT_WEIGHT; notes.push(`没有重量信息，暂按 ${DEFAULT_WEIGHT} 克`); }
  const dimensionsCm = source.dimensionsCm ?? content.estimatedDimensionsCm ?? DEFAULT_DIMS;
  if (!source.dimensionsCm) notes.push('尺寸是估算值');
  return { weightGrams, dimensionsCm };
}

/** 查行情并定价。 */
export async function priceDraft(
  deps: Omit<PipelineDeps, 'tiktok' | 'translator'>,
  source: SourceProduct,
  content: JaContent,
  categoryPath: string[],
  size: { weightGrams: number; dimensionsCm: Dimensions },
  notes: string[],
) {
  const { listings, errors } = await searchMarket(deps.fetchImpl, deps.marketKeys, content.marketQuery);
  for (const e of errors) notes.push(`行情查询失败：${e}`);
  const comparables = await matchComparables(deps.claude, content, listings);
  const market = marketStats(comparables, deps.pricing.market);
  const pricing = priceProduct({
    skus: source.skus.map((s) => ({ sourceSkuId: s.sourceSkuId, priceCny: s.priceCny })),
    weightGrams: size.weightGrams,
    dimensionsCm: size.dimensionsCm,
    domesticShippingCny: source.domesticShippingCny,
    categoryPath,
    fxCnyJpy: await deps.fx.rate('CNY/JPY'),
    market,
  }, deps.pricing);
  if (!Object.keys(deps.pricing.commission.categories).some((c) => categoryPath.includes(c))) {
    notes.push(`类目 ${categoryPath.join(' > ')} 没有匹配到佣金表，按 ${deps.pricing.commission.fallback * 100}% 计算`);
  }
  return pricing;
}

export async function buildDraft(deps: PipelineDeps, shop: Shop, source: SourceProduct): Promise<ListingDraft> {
  const flags = precheck(source);

  const notes: string[] = [];
  const id = randomUUID();

  // 发品路径要先定，类目和属性接口分本地和全球两套。
  const listingRoute = (await deps.tiktok.hasGlobalProductPermission(shop)) ? 'global' : 'local';

  // 文案
  const content = await localizeChecked(deps, source, notes);
  flags.push(...content.riskFlags);
  assertContentSafe(content);

  // 图片
  const images = await uploadImages(deps, shop, await collectImages(deps, source, notes), notes);
  if (images.length === 0) throw new ListingBlocked(['商品图全部处理失败，TikTok 要求至少 1 张']);
  if (images.length < 5) notes.push(`只有 ${images.length} 张主图，官方建议至少 5 张`);

  // 类目和属性
  const category = await deps.tiktok.recommendCategory(
    shop,
    listingRoute,
    content.title,
    images.map((i) => i.uri),
    descriptionHtml(content.descriptionParagraphs),
  );
  const [rawAttributes, rules] = await Promise.all([
    deps.tiktok.categoryAttributes(shop, listingRoute, category.leafId),
    deps.tiktok.categoryRules(shop, listingRoute, category.leafId),
  ]);
  const filled = await fillAttributes(deps.claude, content, source, rawAttributes);
  if (filled.missing.length > 0) notes.push(`必填属性没填上：${filled.missing.join('、')}`);
  for (const cert of rules?.product_certifications ?? []) {
    if (cert.is_required) flags.push({ level: 'review', reason: `类目要求认证：${cert.name}` });
  }

  // 重量、尺寸、行情和定价
  const size = resolveSize(source, content, notes);
  const pricing = await priceDraft(deps, source, content, category.path, size, notes);

  const prices = new Map(pricing.skus.map((s) => [s.sourceSkuId, s.priceJpy]));
  const skus = buildSkus(id, source, content, prices, deps.pricing.inventory.defaultStock);

  // 仓库
  const warehouseId = await deps.tiktok.salesWarehouse(shop);
  const globalWarehouseId = listingRoute === 'global' ? await deps.tiktok.globalWarehouse(shop) : null;

  const draft: ListingDraft = {
    id,
    shopId: shop.id,
    source,
    content,
    images,
    categoryId: category.leafId,
    categoryPath: category.path,
    attributes: filled.attributes,
    pricing,
    skus,
    weightGrams: size.weightGrams,
    dimensionsCm: size.dimensionsCm,
    warehouseId,
    globalWarehouseId,
    listingRoute,
    check: { passed: true, failReasons: [], warnings: [] },
    notes,
    risk: overallRisk(flags),
    previewImageKeys: [],
    createdAt: Date.now(),
    packageDir: null,
  };
  for (const f of flags) notes.push(`风险：${f.reason}`);

  // 官方检查接口只支持本地商品。全球商品要等发布结果。
  if (listingRoute === 'local') {
    draft.check = await deps.tiktok.checkListing(shop, buildLocalProduct(draft));
  } else {
    notes.push('全球商品路径没有提交前检查，结果以发布回执为准');
  }
  return draft;
}
