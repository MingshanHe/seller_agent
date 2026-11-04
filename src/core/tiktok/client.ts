// TikTok Shop Partner API 客户端：签名、重试、错误处理，以及本项目用到的接口。
import { sign } from './sign.ts';
import type { FetchLike, Shop } from '../types.ts';

export const BASE_URL = 'https://open-api.tiktokglobalshop.com';
export const AUTH_URL = 'https://auth.tiktok-shops.com';

export class TikTokApiError extends Error {
  code: number | string;
  requestId?: string;
  httpStatus: number;
  constructor(message: string, code: number | string, httpStatus: number, requestId?: string) {
    super(message);
    this.name = 'TikTokApiError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.requestId = requestId;
  }
}

export interface TikTokOptions {
  appKey: string;
  appSecret: string;
  fetchImpl: FetchLike;
  baseUrl?: string;
  authUrl?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

interface CallOptions {
  shop?: Shop;
  /** 卖家级接口不带 shop_cipher，只传令牌。 */
  accessToken?: string;
  /** 写接口默认不重试：结果不确定时重试可能重复上架。 */
  retry?: boolean;
  query?: Record<string, string | undefined>;
  json?: unknown;
  form?: FormData;
}

export interface TokenSet {
  accessToken: string;
  accessTokenExpireAt: number;
  refreshToken: string;
  refreshTokenExpireAt: number;
  sellerName?: string;
}

export type ListingRoute = 'local' | 'global';

export interface CategoryAttribute {
  id: string;
  name: string;
  type: string;
  required: boolean;
  customizable: boolean;
  multiple: boolean;
  values: { id: string; name: string }[];
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 网络错误、429 和 5xx。写接口遇到这些情况时，请求可能已经生效。 */
export function isTransient(err: unknown): boolean {
  if (err instanceof TikTokApiError) return err.httpStatus === 429 || err.httpStatus >= 500;
  return true;
}

const seller = (shop: Shop) => ({ accessToken: shop.accessToken });

export class TikTokClient {
  private o: TikTokOptions;

  constructor(options: TikTokOptions) {
    this.o = options;
  }

  private nowSec(): number {
    return Math.floor((this.o.now ?? Date.now)() / 1000);
  }

  async call(method: string, path: string, opts: CallOptions = {}): Promise<any> {
    const maxRetries = this.o.maxRetries ?? 4;
    const canRetry = opts.retry ?? method === 'GET';
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(method, path, opts);
      } catch (err) {
        if (!canRetry || attempt >= maxRetries || !isTransient(err)) throw err;
        await (this.o.sleep ?? wait)(Math.min(30000, 1000 * 2 ** attempt));
      }
    }
  }

  private async once(method: string, path: string, opts: CallOptions): Promise<any> {
    const query: [string, string][] = [
      ['app_key', this.o.appKey],
      ['timestamp', String(this.nowSec())],
    ];
    if (opts.shop) query.push(['shop_cipher', opts.shop.cipher]);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) query.push([k, v]);
    }

    const body = opts.json !== undefined ? JSON.stringify(opts.json) : null;
    const contentType = opts.form ? 'multipart/form-data' : body ? 'application/json' : null;
    const signature = sign({ path, query, contentType, body, appSecret: this.o.appSecret });
    const search = new URLSearchParams([...query, ['sign', signature]]);

    const headers: Record<string, string> = {};
    const token = opts.accessToken ?? opts.shop?.accessToken;
    if (token) headers['x-tts-access-token'] = token;
    if (body) headers['content-type'] = 'application/json';

    const res = await this.o.fetchImpl(`${this.o.baseUrl ?? BASE_URL}${path}?${search}`, {
      method,
      headers,
      body: opts.form ?? body ?? undefined,
    });

    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new TikTokApiError(`非 JSON 响应（HTTP ${res.status}）`, 'bad_response', res.status);
    }
    if (!res.ok || data.code !== 0) {
      throw new TikTokApiError(data.message ?? `HTTP ${res.status}`, data.code ?? res.status, res.status, data.request_id);
    }
    return data.data;
  }

  // ---------- 授权 ----------

  private async tokenRequest(path: string, params: Record<string, string>): Promise<TokenSet> {
    const q = new URLSearchParams({ app_key: this.o.appKey, app_secret: this.o.appSecret, ...params });
    const res = await this.o.fetchImpl(`${this.o.authUrl ?? AUTH_URL}${path}?${q}`);
    const data: any = await res.json();
    if (data.code !== 0) throw new TikTokApiError(data.message ?? '换取令牌失败', data.code, res.status, data.request_id);
    const d = data.data;
    return {
      accessToken: d.access_token,
      accessTokenExpireAt: d.access_token_expire_in,
      refreshToken: d.refresh_token,
      refreshTokenExpireAt: d.refresh_token_expire_in,
      sellerName: d.seller_name,
    };
  }

  exchangeCode(code: string): Promise<TokenSet> {
    return this.tokenRequest('/api/v2/token/get', { auth_code: code, grant_type: 'authorized_code' });
  }

  refreshToken(refreshToken: string): Promise<TokenSet> {
    return this.tokenRequest('/api/v2/token/refresh', { refresh_token: refreshToken, grant_type: 'refresh_token' });
  }

  async authorizedShops(accessToken: string): Promise<{ id: string; name: string; region: string; cipher: string }[]> {
    const d = await this.call('GET', '/authorization/202309/shops', { accessToken });
    return d.shops ?? [];
  }

  // ---------- 商品 ----------

  async hasGlobalProductPermission(shop: Shop): Promise<boolean> {
    try {
      const d = await this.call('GET', '/seller/202309/permissions', seller(shop));
      return (d.permissions ?? []).includes('MANAGE_GLOBAL_PRODUCT');
    } catch (err) {
      // 应用没开 Global Shop Information 权限时，按本地商品路径继续。
      if (err instanceof TikTokApiError && !isTransient(err)) return false;
      throw err;
    }
  }

  async salesWarehouse(shop: Shop): Promise<string> {
    const d = await this.call('GET', '/logistics/202309/warehouses', { shop });
    const list: any[] = d.warehouses ?? [];
    const sales = list.filter((w) => w.type === 'SALES_WAREHOUSE' && w.effect_status === 'ENABLED');
    const chosen = sales.find((w) => w.is_default) ?? sales[0];
    if (!chosen) throw new Error('这个店铺没有可用的发货仓');
    return chosen.id;
  }

  async globalWarehouse(shop: Shop): Promise<string> {
    const d = await this.call('GET', '/logistics/202309/global_warehouses', seller(shop));
    const first = (d.global_warehouses ?? [])[0];
    if (!first) throw new Error('这个卖家没有全球仓库');
    return first.id;
  }

  async uploadImage(shop: Shop, bytes: Uint8Array, filename: string, useCase = 'MAIN_IMAGE'): Promise<string> {
    const form = new FormData();
    form.set('data', new Blob([bytes.slice()]), filename);
    form.set('use_case', useCase);
    const d = await this.call('POST', '/product/202309/images/upload', { ...seller(shop), form, retry: true });
    return d.uri;
  }

  /** 返回从一级到叶子的类目。本地路径用 en-US，才能和官方英文佣金表匹配。 */
  async recommendCategory(shop: Shop, route: ListingRoute, title: string, imageUris: string[], description: string) {
    const body = { product_title: title, description, images: imageUris.map((uri) => ({ uri })) };
    const d = route === 'global'
      ? await this.call('POST', '/product/202309/global_categories/recommend', { ...seller(shop), json: body, retry: true })
      : await this.call('POST', '/product/202309/categories/recommend', { shop, json: { ...body, locale: 'en-US' }, retry: true });
    const path: { id: string; name: string; is_leaf?: boolean }[] = d.categories ?? [];
    const leafId: string | undefined = d.leaf_category_id ?? path.find((c) => c.is_leaf)?.id;
    if (!leafId) throw new Error('TikTok 没有推荐出可用类目');
    return { leafId, path: path.map((c) => c.name) };
  }

  async categoryAttributes(shop: Shop, route: ListingRoute, categoryId: string): Promise<CategoryAttribute[]> {
    const d = route === 'global'
      ? await this.call('GET', `/product/202309/categories/${categoryId}/global_attributes`, { ...seller(shop), query: { locale: 'ja-JP' } })
      : await this.call('GET', `/product/202309/categories/${categoryId}/attributes`, { shop, query: { locale: 'ja-JP' } });
    return (d.attributes ?? []).map((a: any) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      required: Boolean(a.is_requried), // 官方字段就是这个拼写
      customizable: Boolean(a.is_customizable),
      multiple: Boolean(a.is_multiple_selection),
      values: (a.values ?? []).map((v: any) => ({ id: v.id, name: v.name })),
    }));
  }

  async categoryRules(shop: Shop, route: ListingRoute, categoryId: string): Promise<any> {
    return route === 'global'
      ? this.call('GET', `/product/202309/categories/${categoryId}/global_rules`, seller(shop))
      : this.call('GET', `/product/202309/categories/${categoryId}/rules`, { shop });
  }

  /** 检查结果不是明确的 PASS 就算不通过。warnings 在文档里是对象，也可能是数组。 */
  async checkListing(shop: Shop, body: unknown): Promise<{ passed: boolean; failReasons: string[]; warnings: string[] }> {
    const d = await this.call('POST', '/product/202309/products/listing_check', { shop, json: body, retry: true });
    const list = (x: unknown): unknown[] => (x == null ? [] : Array.isArray(x) ? x : [x]);
    const msg = (x: any) => (typeof x === 'string' ? x : x?.message ?? JSON.stringify(x));
    const failReasons = list(d.fail_reasons).map(msg);
    const passed = d.check_result === 'PASS';
    if (!passed && failReasons.length === 0) failReasons.push(`官方检查结果：${d.check_result ?? '没有返回'}`);
    return { passed, failReasons, warnings: list(d.warnings).map(msg).filter(Boolean) };
  }

  async createProduct(shop: Shop, body: unknown): Promise<{ productId: string; skus: { id: string; seller_sku: string }[] }> {
    const d = await this.call('POST', '/product/202309/products', { shop, json: body });
    return { productId: d.product_id, skus: d.skus ?? [] };
  }

  async createGlobalProduct(shop: Shop, body: unknown): Promise<{ globalProductId: string; globalSkus: any[] }> {
    const d = await this.call('POST', '/product/202309/global_products', { ...seller(shop), json: body });
    return { globalProductId: d.global_product_id, globalSkus: d.global_skus ?? [] };
  }

  async publishGlobalProduct(shop: Shop, globalProductId: string, body: unknown): Promise<any> {
    return this.call('POST', `/product/202309/global_products/${globalProductId}/publish`, { ...seller(shop), json: body });
  }

  /**
   * 官方的库存接口下限是 1，不能改成 0。
   * 货源断货时用官方建议的下架接口，整个商品对买家隐藏，之后可以重新上架。
   */
  async deactivateProduct(shop: Shop, productId: string): Promise<void> {
    const d = await this.call('POST', '/product/202309/products/deactivate', { shop, json: { product_ids: [productId] } });
    // 官方说明：即使顶层 code 是 0，也要看单个商品的错误。
    if (d?.errors?.length) throw new Error(`下架失败：${JSON.stringify(d.errors[0])}`);
  }

  // ---------- 订单 ----------

  async getOrder(shop: Shop, orderId: string): Promise<any> {
    const d = await this.call('GET', '/order/202507/orders', { shop, query: { ids: orderId } });
    const order = (d.orders ?? [])[0];
    if (!order) throw new Error(`查不到订单 ${orderId}`);
    return order;
  }
}
