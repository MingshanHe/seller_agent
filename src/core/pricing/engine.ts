// 定价引擎：纯函数，不访问网络。所有参数来自 config/pricing.jp.json。
import type { Dimensions, MarketStats, PricingDecision, PricingResult, PricingSku } from '../types.ts';

export interface PricingConfig {
  logistics: {
    volumetricDivisor: number;
    firstWeightGrams: number;
    firstFeeCny: number;
    stepWeightGrams: number;
    stepFeeCny: number;
    defaultDomesticCny: number;
    lastMileJpy: number;
  };
  rates: { refundLoss: number; affiliate: number; fxBuffer: number };
  margin: { min: number; target: number };
  market: {
    minComparables: number;
    targetPercentile: number;
    rejectAbovePercentile: number;
    assumedShippingJpy: number;
  };
  tax: { reserveAboveJpy: number; reserveRate: number };
  limits: { minPriceJpy: number; maxPriceJpy: number };
  inventory: { defaultStock: number };
  commission: {
    fallback: number;
    categories: Record<string, number>;
    exceptions: Record<string, number>;
  };
}

export interface PricingInput {
  skus: { sourceSkuId: string; priceCny: number }[];
  weightGrams: number;
  dimensionsCm: Dimensions;
  domesticShippingCny?: number;
  categoryPath: string[];
  fxCnyJpy: number;
  market: MarketStats | null;
}

export function billableGrams(weightGrams: number, d: Dimensions, divisor: number): number {
  const volumetricKg = (d.l * d.w * d.h) / divisor;
  return Math.ceil(Math.max(weightGrams, volumetricKg * 1000));
}

export function crossBorderFeeCny(grams: number, c: PricingConfig['logistics']): number {
  if (grams <= c.firstWeightGrams) return c.firstFeeCny;
  const steps = Math.ceil((grams - c.firstWeightGrams) / c.stepWeightGrams);
  return c.firstFeeCny + steps * c.stepFeeCny;
}

/** 先匹配子类目例外，再匹配一级类目，都没有就用最高档，宁可高估费用。 */
export function commissionRate(path: string[], c: PricingConfig['commission']): number {
  for (const name of path) {
    if (name in c.exceptions) return c.exceptions[name];
  }
  for (const name of path) {
    if (name in c.categories) return c.categories[name];
  }
  return c.fallback;
}

/** 向上进位到 80 结尾：5,000 日元以内每 100 一档，以上每 500 一档（x,480 / x,980）。 */
export function roundUpJpy(price: number): number {
  const p = Math.ceil(price);
  if (p <= 80) return 80;
  if (p <= 5000) return Math.ceil((p - 80) / 100) * 100 + 80;
  return Math.ceil((p - 480) / 500) * 500 + 480;
}

function percentRates(c: PricingConfig, commission: number): number {
  return commission + c.rates.refundLoss + c.rates.affiliate;
}

/** 低于这个含税售价，这个 SKU 就达不到最低利润率。 */
function floorPrice(fixedJpy: number, rates: number, margin: number, tax: PricingConfig['tax']): number {
  const noTax = fixedJpy / (1 - rates - margin);
  if (noTax <= tax.reserveAboveJpy) return Math.ceil(noTax);
  return Math.ceil(fixedJpy / (1 - rates - margin - tax.reserveRate));
}

function profitAt(price: number, fixedJpy: number, rates: number, tax: PricingConfig['tax']) {
  const taxRate = price > tax.reserveAboveJpy ? tax.reserveRate : 0;
  const profit = price * (1 - rates - taxRate) - fixedJpy;
  return { profit: Math.round(profit), margin: profit / price };
}

/** 这个售价下允许的最低价。售价超过预留门槛时要把消费税算进去。 */
export function minPriceFor(priceJpy: number, fixedCostJpy: number, commission: number, c: PricingConfig): number {
  const taxRate = priceJpy > c.tax.reserveAboveJpy ? c.tax.reserveRate : 0;
  return Math.ceil(fixedCostJpy / (1 - percentRates(c, commission) - c.margin.min - taxRate));
}

export function priceProduct(input: PricingInput, c: PricingConfig): PricingResult {
  if (input.skus.length === 0) throw new Error('没有可定价的 SKU');
  if (!(input.fxCnyJpy > 0)) throw new Error('汇率无效');

  const grams = billableGrams(input.weightGrams, input.dimensionsCm, c.logistics.volumetricDivisor);
  const crossBorder = crossBorderFeeCny(grams, c.logistics);
  const domestic = input.domesticShippingCny ?? c.logistics.defaultDomesticCny;
  const commission = commissionRate(input.categoryPath, c.commission);
  const rates = percentRates(c, commission);
  if (rates + c.margin.target >= 1) throw new Error('费率和利润率之和不能达到 100%');

  const fx = input.fxCnyJpy * (1 + c.rates.fxBuffer);
  const costed = input.skus.map((s) => {
    const fixedCostJpy = Math.ceil((s.priceCny + domestic + crossBorder) * fx + c.logistics.lastMileJpy);
    return { ...s, fixedCostJpy, floorJpy: floorPrice(fixedCostJpy, rates, c.margin.min, c.tax) };
  });

  // 行情只代表最便宜的那个规格，其他规格按成本比例往上走。
  const anchor = costed.reduce((a, b) => (b.fixedCostJpy < a.fixedCostJpy ? b : a));
  const reasons: string[] = [];
  let decision: PricingDecision = 'ok';
  let anchorPrice: number;

  const m = input.market;
  if (m && m.n >= c.market.minComparables) {
    const targetPct = m.p40;
    anchorPrice = Math.max(targetPct, anchor.floorJpy);
    if (anchor.floorJpy > m.p75) {
      decision = 'reject';
      reasons.push(`保本底线 ¥${anchor.floorJpy} 高于行情第 75 百分位 ¥${m.p75}，建议放弃`);
    } else if (anchor.floorJpy > targetPct) {
      reasons.push(`保本底线高于目标价 ¥${targetPct}，售价按底线走`);
    }
  } else {
    anchorPrice = floorPrice(anchor.fixedCostJpy, rates, c.margin.target, c.tax);
    decision = 'review';
    reasons.push(`同款不足 ${c.market.minComparables} 个，无行情依据，按目标利润率定价`);
  }

  const skus: PricingSku[] = costed.map((s) => {
    const scaled = anchorPrice * (s.fixedCostJpy / anchor.fixedCostJpy);
    let priceJpy = roundUpJpy(Math.max(scaled, s.floorJpy));
    // 进位后可能刚好越过预留消费税的门槛，这时要按含税底线再抬一次。
    if (priceJpy > c.tax.reserveAboveJpy) {
      const withTax = s.fixedCostJpy / (1 - rates - c.margin.min - c.tax.reserveRate);
      priceJpy = Math.max(priceJpy, roundUpJpy(withTax));
    }
    const { profit, margin } = profitAt(priceJpy, s.fixedCostJpy, rates, c.tax);
    return {
      sourceSkuId: s.sourceSkuId,
      purchaseCny: s.priceCny,
      fixedCostJpy: s.fixedCostJpy,
      floorJpy: s.floorJpy,
      priceJpy,
      profitJpy: profit,
      marginRate: Number(margin.toFixed(4)),
    };
  });

  for (const s of skus) {
    if (s.priceJpy > c.limits.maxPriceJpy || s.priceJpy < c.limits.minPriceJpy) {
      decision = 'reject';
      reasons.push(`售价 ¥${s.priceJpy} 超出日本站范围`);
    }
  }

  return {
    decision,
    reasons,
    commissionRate: commission,
    fxCnyJpy: input.fxCnyJpy,
    billableGrams: grams,
    crossBorderCny: crossBorder,
    market: m,
    skus,
  };
}

/**
 * 人工改价：把新价格放到最便宜的规格上，其他规格按原有比例调整。
 * 低于任一规格的底线价时拒绝，防止误操作做成亏本价。
 */
export function overridePrice(result: PricingResult, newAnchorPrice: number, c: PricingConfig): PricingResult {
  const anchor = result.skus.reduce((a, b) => (b.fixedCostJpy < a.fixedCostJpy ? b : a));
  const rates = percentRates(c, result.commissionRate);
  const skus = result.skus.map((s) => {
    const raw = newAnchorPrice * (s.fixedCostJpy / anchor.fixedCostJpy);
    const priceJpy = s === anchor ? Math.ceil(newAnchorPrice) : roundUpJpy(raw);
    const floor = Math.max(s.floorJpy, minPriceFor(priceJpy, s.fixedCostJpy, result.commissionRate, c));
    if (priceJpy < floor) {
      throw new Error(`¥${priceJpy} 低于底线价 ¥${floor}`);
    }
    if (priceJpy > c.limits.maxPriceJpy) throw new Error(`¥${priceJpy} 超出日本站上限`);
    const { profit, margin } = profitAt(priceJpy, s.fixedCostJpy, rates, c.tax);
    return { ...s, priceJpy, profitJpy: profit, marginRate: Number(margin.toFixed(4)) };
  });
  return { ...result, skus, reasons: [...result.reasons, `售价已人工改为 ¥${Math.ceil(newAnchorPrice)}`] };
}

/** 出单时重算利润，用于成本变动。 */
export function recomputeProfit(args: {
  priceJpy: number;
  purchaseCny: number;
  previousPurchaseCny: number;
  previousFixedCostJpy: number;
  fxCnyJpy: number;
  commissionRate: number;
}, c: PricingConfig) {
  const delta = (args.purchaseCny - args.previousPurchaseCny) * args.fxCnyJpy * (1 + c.rates.fxBuffer);
  const fixed = Math.ceil(args.previousFixedCostJpy + delta);
  return { fixedCostJpy: fixed, ...profitAt(args.priceJpy, fixed, percentRates(c, args.commissionRate), c.tax) };
}
