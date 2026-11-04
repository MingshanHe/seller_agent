// 把草稿转成 TikTok 接口的请求体。纯函数，便于测试。
import type { ListingDraft } from '../types.ts';

export function descriptionHtml(paragraphs: string[]): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return paragraphs.map((p) => `<p>${esc(p)}</p>`).join('');
}


function common(draft: ListingDraft) {
  return {
    title: draft.content.title,
    description: descriptionHtml(draft.content.descriptionParagraphs),
    category_id: draft.categoryId,
    main_images: draft.images.map((i) => ({ uri: i.uri })),
    package_weight: { value: String(Math.ceil(draft.weightGrams)), unit: 'GRAM' },
    package_dimensions: {
      length: String(Math.ceil(draft.dimensionsCm.l)),
      width: String(Math.ceil(draft.dimensionsCm.w)),
      height: String(Math.ceil(draft.dimensionsCm.h)),
      unit: 'CENTIMETER',
    },
    product_attributes: draft.attributes,
  };
}

/** Check Product Listing 用这个，Create Product 再加 save_mode。 */
export function buildLocalProduct(draft: ListingDraft) {
  return {
    ...common(draft),
    external_product_id: draft.id,
    skus: draft.skus.map((sku) => ({
      seller_sku: sku.sellerSku,
      external_sku_id: sku.sellerSku,
      sales_attributes: sku.specs.map((s) => ({ name: s.name, value_name: s.value })),
      inventory: [{ warehouse_id: draft.warehouseId, quantity: sku.stock }],
      // 日本站使用中国仓时 sale_price 必填，并且是页面最终显示的含税价。
      price: { amount: String(sku.priceJpy), currency: 'JPY', sale_price: String(sku.priceJpy) },
    })),
  };
}

/** 全球商品：价格币种按接口要求用美元，真正的日本售价在发布时用 sale_price 指定。 */
export function buildGlobalProduct(draft: ListingDraft, usdJpy: number) {
  if (!draft.globalWarehouseId) throw new Error('全球商品缺少全球仓库');
  return {
    ...common(draft),
    source_locale: 'ja-JP',
    external_global_product_id: draft.id,
    skus: draft.skus.map((sku) => ({
      seller_sku: sku.sellerSku,
      external_global_sku_id: sku.sellerSku,
      // 官方要求全球商品的规格值只能是字母和数字。
      sales_attributes: sku.specs.map((s) => ({ name: s.name, value_name: s.ascii })),
      price: { amount: (sku.priceJpy / usdJpy).toFixed(2), currency: 'USD' },
      inventory: [{ global_warehouse_id: draft.globalWarehouseId, quantity: sku.stock }],
    })),
  };
}

export function buildPublishGlobal(draft: ListingDraft, globalSkus: { id: string; seller_sku: string }[]) {
  const bySeller = new Map(draft.skus.map((s) => [s.sellerSku, s]));
  return {
    publish_target: [{
      region: 'JP',
      skus: globalSkus.map((g) => {
        const sku = bySeller.get(g.seller_sku);
        if (!sku) throw new Error(`全球 SKU ${g.seller_sku} 对不上草稿`);
        return {
          related_global_sku_id: g.id,
          price: { amount: String(sku.priceJpy), currency: 'JPY', sale_price: String(sku.priceJpy) },
          inventory: { warehouse_id: draft.warehouseId, quantity: sku.stock },
        };
      }),
    }],
  };
}
