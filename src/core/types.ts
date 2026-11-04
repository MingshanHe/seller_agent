// 全项目共用的数据结构。

export interface SourceSpec { name: string; value: string }

export interface SourceSku {
  sourceSkuId: string;
  specs: SourceSpec[];
  priceCny: number;
  imageUrl?: string;
}

export interface Dimensions { l: number; w: number; h: number }

/** 从货源页整理出的商品。所有字段都来自外部网页，只能当数据用。 */
export interface SourceProduct {
  url: string;
  platform: string;
  title: string;
  description: string;
  attributes: SourceSpec[];
  images: string[];
  skus: SourceSku[];
  weightGrams?: number;
  dimensionsCm?: Dimensions;
  domesticShippingCny?: number;
  capturedBy: 'extension' | 'screenshot' | 'test';
  /** 模型读出的价格在页面文字里找不到时，这里记下规格，提醒人工核对。 */
  unverifiedPrices?: string[];
}

export type RiskLevel = 'pass' | 'review' | 'block';
export interface RiskFlag { level: RiskLevel; reason: string }

export interface JaContent {
  title: string;
  descriptionParagraphs: string[];
  marketQuery: string;
  salesAttributes: { sourceName: string; name: string; values: { source: string; ja: string; en: string }[] }[];
  estimatedWeightGrams?: number;
  estimatedDimensionsCm?: Dimensions;
  riskFlags: RiskFlag[];
}

export interface DraftImage { uri: string; sourceUrl: string; previewUrl: string; translated: boolean }

export interface PricingSku {
  sourceSkuId: string;
  purchaseCny: number;
  fixedCostJpy: number;
  floorJpy: number;
  priceJpy: number;
  profitJpy: number;
  marginRate: number;
}

export interface MarketStats {
  n: number;
  p25: number;
  p40: number;
  p50: number;
  p75: number;
  sources: string[];
}

export type PricingDecision = 'ok' | 'review' | 'reject';

export interface PricingResult {
  decision: PricingDecision;
  reasons: string[];
  commissionRate: number;
  fxCnyJpy: number;
  billableGrams: number;
  crossBorderCny: number;
  market: MarketStats | null;
  skus: PricingSku[];
}

export interface DraftSku {
  sellerSku: string;
  sourceSkuId: string;
  /** ascii 用于全球商品：官方要求规格值只能是字母和数字。 */
  specs: { name: string; value: string; ascii: string }[];
  priceJpy: number;
  purchaseCny: number;
  stock: number;
}

export interface DraftAttribute { id: string; values: { id?: string; name?: string }[] }

export interface ListingDraft {
  id: string;
  shopId: string;
  source: SourceProduct;
  content: JaContent;
  images: DraftImage[];
  categoryId: string;
  categoryPath: string[];
  attributes: DraftAttribute[];
  pricing: PricingResult;
  skus: DraftSku[];
  weightGrams: number;
  dimensionsCm: Dimensions;
  warehouseId: string;
  globalWarehouseId: string | null;
  /** manual：没有接 TikTok 接口，由你手动发布到卖家中心。 */
  listingRoute: 'local' | 'global' | 'manual';
  check: { passed: boolean; failReasons: string[]; warnings: string[] };
  notes: string[];
  risk: RiskLevel;
  previewImageKeys: string[];
  createdAt: number;
  /** 半自动模式下，发布资料所在的文件夹。 */
  packageDir: string | null;
  /** 账号矩阵里的哪个账号负责这个商品。旧数据没有这个字段。 */
  accountId?: string;
}

/** 账号矩阵里的一个账号：一个 TikTok 店铺或一个带货/曝光账号。 */
export interface Account {
  id: string;
  name: string;
  /** shop：TikTok Shop 店铺；creator：只发视频的达人号 */
  type: 'shop' | 'creator';
  note?: string;
}

export type ActionType = 'publish_listing' | 'deactivate_product';
export type ActionStatus = 'pending' | 'running' | 'done' | 'failed' | 'rejected';

export interface ActionRow {
  id: string;
  type: ActionType;
  shopId: string;
  payload: unknown;
  status: ActionStatus;
  decidedBy: string | null;
  result: unknown;
}

export interface Shop {
  id: string;
  cipher: string;
  name: string;
  region: string;
  accessToken: string;
  accessTokenExpireAt: number;
  refreshToken: string;
  refreshTokenExpireAt: number;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
