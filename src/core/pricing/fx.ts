// 汇率。优先用环境变量里的固定值，否则读 Frankfurter，并缓存 6 小时。
import type { FetchLike } from '../types.ts';

const TTL_MS = 6 * 3600 * 1000;
const BOUNDS: Record<string, [number, number]> = { 'CNY/JPY': [10, 40], 'USD/JPY': [80, 250] };

export interface FxOptions {
  fetchImpl: FetchLike;
  fixed?: Partial<Record<'CNY/JPY' | 'USD/JPY', number>>;
  now?: () => number;
}

export class FxProvider {
  private cache = new Map<string, { rate: number; at: number }>();
  private opts: FxOptions;

  constructor(opts: FxOptions) {
    this.opts = opts;
  }

  async rate(pair: 'CNY/JPY' | 'USD/JPY'): Promise<number> {
    const fixed = this.opts.fixed?.[pair];
    if (fixed) return fixed;

    const now = (this.opts.now ?? Date.now)();
    const cached = this.cache.get(pair);
    if (cached && now - cached.at < TTL_MS) return cached.rate;

    const [from, to] = pair.split('/');
    try {
      const res = await this.opts.fetchImpl(`https://api.frankfurter.dev/v1/latest?base=${from}&symbols=${to}`);
      if (!res.ok) throw new Error(`汇率接口返回 ${res.status}`);
      const data: any = await res.json();
      const rate = Number(data?.rates?.[to]);
      const [lo, hi] = BOUNDS[pair];
      if (!(rate >= lo && rate <= hi)) throw new Error(`汇率 ${rate} 超出合理范围`);
      this.cache.set(pair, { rate, at: now });
      return rate;
    } catch (err) {
      // 接口临时失败时沿用上一次的值；从未成功过就报错，不用猜的汇率定价。
      if (cached) return cached.rate;
      throw err;
    }
  }
}
