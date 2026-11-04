// 日本行情：乐天和 Yahoo!ショッピング 官方搜索接口。
import type { FetchLike, MarketStats } from '../types.ts';

export interface MarketListing {
  source: 'rakuten' | 'yahoo';
  title: string;
  priceJpy: number;
  shippingIncluded: boolean;
  url: string;
}

export interface MarketKeys {
  rakutenAppId?: string;
  rakutenAccessKey?: string;
  yahooAppId?: string;
}

const RAKUTEN_URL = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701';
const YAHOO_URL = 'https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch';

async function getJson(fetchImpl: FetchLike, url: string, label: string): Promise<any> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${label} 返回 ${res.status}`);
  return res.json();
}

export async function searchRakuten(fetchImpl: FetchLike, keys: MarketKeys, keyword: string): Promise<MarketListing[]> {
  if (!keys.rakutenAppId || !keys.rakutenAccessKey) return [];
  const q = new URLSearchParams({
    applicationId: keys.rakutenAppId,
    accessKey: keys.rakutenAccessKey,
    keyword,
    hits: '30',
    formatVersion: '2',
  });
  const data = await getJson(fetchImpl, `${RAKUTEN_URL}?${q}`, '乐天搜索');
  const items: any[] = data.items ?? data.Items ?? [];
  return items.flatMap((entry) => {
    const it = entry.item ?? entry.Item ?? entry;
    const priceJpy = Number(it.itemPrice);
    if (!Number.isFinite(priceJpy) || priceJpy <= 0) return [];
    return [{
      source: 'rakuten' as const,
      title: String(it.itemName ?? ''),
      priceJpy,
      // 官方文档输出说明写 0 为含运费。上线时要用真实响应核对一次。
      shippingIncluded: it.postageFlag === 0,
      url: String(it.itemUrl ?? ''),
    }];
  });
}

export async function searchYahoo(fetchImpl: FetchLike, keys: MarketKeys, keyword: string): Promise<MarketListing[]> {
  if (!keys.yahooAppId) return [];
  const q = new URLSearchParams({ appid: keys.yahooAppId, query: keyword, results: '30', sort: '-score' });
  const data = await getJson(fetchImpl, `${YAHOO_URL}?${q}`, 'Yahoo 搜索');
  const hits: any[] = data.hits ?? [];
  return hits.flatMap((it) => {
    const priceJpy = Number(it.price);
    if (!Number.isFinite(priceJpy) || priceJpy <= 0) return [];
    return [{
      source: 'yahoo' as const,
      title: String(it.name ?? ''),
      priceJpy,
      // shipping.code：1 未设置，2 包邮，3 有条件包邮。有条件包邮按不含运费算。
      shippingIncluded: it.shipping?.code === 2,
      url: String(it.url ?? ''),
    }];
  });
}

/** 单个来源失败不影响另一个，都失败时返回空列表，后续按“无行情”处理。 */
export async function searchMarket(fetchImpl: FetchLike, keys: MarketKeys, keyword: string): Promise<{ listings: MarketListing[]; errors: string[] }> {
  const results = await Promise.allSettled([
    searchRakuten(fetchImpl, keys, keyword),
    searchYahoo(fetchImpl, keys, keyword),
  ]);
  const listings: MarketListing[] = [];
  const errors: string[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') listings.push(...r.value);
    else errors.push(String(r.reason?.message ?? r.reason));
  }
  return { listings, errors };
}

/** 线性插值分位数，p 取 0–100。 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) throw new Error('空序列没有分位数');
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** 含运费后的行情。不含运费的商品加上假设运费，才能和包邮的 TikTok 售价比较。 */
export function marketStats(
  listings: MarketListing[],
  opts: { assumedShippingJpy: number; targetPercentile: number; rejectAbovePercentile: number },
): MarketStats | null {
  if (listings.length === 0) return null;
  const landed = listings
    .map((l) => l.priceJpy + (l.shippingIncluded ? 0 : opts.assumedShippingJpy))
    .sort((a, b) => a - b);
  const at = (p: number) => Math.round(percentile(landed, p));
  return {
    n: landed.length,
    p25: at(25),
    p40: at(opts.targetPercentile),
    p50: at(50),
    p75: at(opts.rejectAbovePercentile),
    sources: [...new Set(listings.map((l) => l.source))],
  };
}
