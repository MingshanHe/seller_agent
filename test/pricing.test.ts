import test from 'node:test';
import assert from 'node:assert/strict';
import { billableGrams, commissionRate, crossBorderFeeCny, overridePrice, priceProduct, recomputeProfit, roundUpJpy, type PricingInput } from '../src/core/pricing/engine.ts';
import { marketStats, percentile } from '../src/core/pricing/market.ts';
import { loadPricing } from '../scripts/harness.ts';

const c = loadPricing();
const market = (prices: number[]) => marketStats(
  prices.map((p) => ({ source: 'rakuten' as const, title: '', priceJpy: p, shippingIncluded: true, url: '' })),
  c.market,
);

const base: PricingInput = {
  skus: [{ sourceSkuId: '1', priceCny: 18 }, { sourceSkuId: '2', priceCny: 21 }],
  weightGrams: 320,
  dimensionsCm: { l: 22, w: 8, h: 8 },
  categoryPath: ['Kitchenware', 'Drinkware'],
  fxCnyJpy: 21,
  market: market([1800, 2000, 2200, 2400, 2600, 2800, 3000]),
};

test('计费重取实重和体积重的较大值', () => {
  assert.equal(billableGrams(320, { l: 22, w: 8, h: 8 }, 8000), 320);
  assert.equal(billableGrams(100, { l: 40, w: 30, h: 20 }, 8000), 3000);
});

test('跨境运费按首重加续重阶梯计算', () => {
  const l = c.logistics;
  assert.equal(crossBorderFeeCny(1, l), 36);
  assert.equal(crossBorderFeeCny(500, l), 36);
  assert.equal(crossBorderFeeCny(501, l), 54);
  assert.equal(crossBorderFeeCny(1000, l), 54);
  assert.equal(crossBorderFeeCny(1001, l), 72);
});

test('佣金先看子类目例外，再看一级类目，都没有用最高档', () => {
  assert.equal(commissionRate(['Kitchenware', 'Drinkware'], c.commission), 0.09);
  assert.equal(commissionRate(['Home Supplies', 'Towels'], c.commission), 0.07);
  assert.equal(commissionRate(['Pet Supplies', 'Dog & Cat Food'], c.commission), 0.07);
  assert.equal(commissionRate(['Food & Beverages', 'Beer, Wine & Spirits'], c.commission), 0.12);
  assert.equal(commissionRate(['没见过的类目'], c.commission), 0.12);
});

test('售价向上进位到 80 结尾', () => {
  for (const [input, want] of [[50, 80], [632, 680], [680, 680], [681, 780], [2281, 2380], [4980, 4980], [4981, 5080], [5001, 5480], [5481, 5980], [10001, 10480]] as const) {
    assert.equal(roundUpJpy(input), want, String(input));
  }
});

test('手算算例：行情价高于底线时按第 40 百分位定价', () => {
  // 蓝色：(18 + 5 + 36) × 21 × 1.02 + 350 = 1613.78，向上取整 1614
  // 底线：1614 ÷ (1 − 0.09 − 0.03 − 0.15) = 2210.96，取 2211
  // 行情第 40 百分位：2200 + 0.4 × 200 = 2280
  const r = priceProduct(base, c);
  assert.equal(r.decision, 'ok');
  const [blue, black] = r.skus;
  assert.equal(blue.fixedCostJpy, 1614);
  assert.equal(blue.floorJpy, 2211);
  assert.equal(blue.priceJpy, 2280);
  assert.equal(blue.profitJpy, 392); // 2280 × 0.88 − 1614
  assert.equal(black.fixedCostJpy, 1679);
  assert.equal(black.priceJpy, 2380); // 2280 × 1679 ÷ 1614 = 2371.8，进位
  assert.ok(black.priceJpy >= black.floorJpy);
});

test('底线高于目标价但低于第 75 百分位：按底线走并说明', () => {
  const r = priceProduct({ ...base, market: market([1900, 2000, 2100, 2200, 2300, 2400, 2500]) }, c);
  assert.equal(r.decision, 'ok');
  assert.ok(r.skus[0].priceJpy >= 2211);
  assert.match(r.reasons.join(), /底线/);
});

test('底线高于第 75 百分位：建议放弃', () => {
  const r = priceProduct({ ...base, market: market([1000, 1100, 1200, 1300, 1400, 1500, 1600]) }, c);
  assert.equal(r.decision, 'reject');
  assert.match(r.reasons.join(), /建议放弃/);
});

test('同款不足时按目标利润率定价，并要求人工看', () => {
  const r = priceProduct({ ...base, market: market([2000, 2200]) }, c);
  assert.equal(r.decision, 'review');
  assert.ok(r.skus[0].marginRate >= c.margin.target - 0.001);
  assert.match(r.reasons.join(), /无行情依据/);
});

test('没有行情数据也能定价', () => {
  const r = priceProduct({ ...base, market: null }, c);
  assert.equal(r.decision, 'review');
  assert.equal(r.market, null);
});

test('任何售价都不低于底线，利润率不低于最低值', () => {
  for (const cny of [1, 5, 18, 50, 120, 300, 800, 2000]) {
    for (const weight of [100, 500, 1500, 5000]) {
      const r = priceProduct({ ...base, skus: [{ sourceSkuId: '1', priceCny: cny }], weightGrams: weight }, c);
      for (const s of r.skus) {
        assert.ok(s.priceJpy >= s.floorJpy, `${cny}/${weight}`);
        assert.ok(s.marginRate >= c.margin.min - 0.0005, `${cny}/${weight} 利润率 ${s.marginRate}`);
      }
    }
  }
});

test('售价超过 ¥10,000 时预留消费税，利润率仍然达标', () => {
  // 底线不到 1 万，但进位后越过门槛，要按含税底线再抬一次
  const r = priceProduct({ ...base, skus: [{ sourceSkuId: '1', priceCny: 300 }], market: market([10000, 10050, 10080, 10100, 10150, 10200, 10300]) }, c);
  const s = r.skus[0];
  assert.ok(s.priceJpy > c.tax.reserveAboveJpy);
  assert.ok(s.marginRate >= c.margin.min - 0.0005, `利润率 ${s.marginRate}`);
});

test('汇率无效时报错，不用猜的汇率定价', () => {
  assert.throws(() => priceProduct({ ...base, fxCnyJpy: 0 }, c), /汇率/);
});

test('人工改价：低于底线被拒绝，高于底线按比例调整', () => {
  const r = priceProduct(base, c);
  assert.throws(() => overridePrice(r, 2000, c), /低于底线/);
  const up = overridePrice(r, 2980, c);
  assert.equal(up.skus[0].priceJpy, 2980);
  assert.ok(up.skus[1].priceJpy > 2980);
  assert.ok(up.skus[0].profitJpy > r.skus[0].profitJpy);
});

test('人工改价越过 ¥10,000 时按含税底线检查', () => {
  // 成本 7291：不含税底线 9988，含税底线 11455。改成 10001 看着够，其实利润率只有 6%。
  const r = priceProduct({ ...base, skus: [{ sourceSkuId: '1', priceCny: 283 }], market: null }, c);
  const fixed = r.skus[0].fixedCostJpy;
  assert.ok(fixed > 7000 && fixed < 7500, String(fixed));
  assert.throws(() => overridePrice({ ...r, skus: [{ ...r.skus[0], floorJpy: 9000 }] }, 10001, c), /低于底线/);
  const ok = overridePrice(r, 11980, c);
  assert.ok(ok.skus[0].marginRate >= c.margin.min - 0.0005);
});

test('成本上涨时利润跟着下降', () => {
  const r = recomputeProfit({
    priceJpy: 2280, purchaseCny: 28, previousPurchaseCny: 18, previousFixedCostJpy: 1614, fxCnyJpy: 21, commissionRate: 0.09,
  }, c);
  assert.equal(r.fixedCostJpy, 1829); // 1614 + 10 × 21 × 1.02 = 1828.2
  assert.equal(r.profit, 177); // 2280 × 0.88 − 1829
});

test('分位数线性插值', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([10], 75), 10);
});

test('行情含运费：不包邮的商品要加假设运费', () => {
  const s = marketStats([
    { source: 'rakuten', title: '', priceJpy: 1000, shippingIncluded: false, url: '' },
    { source: 'yahoo', title: '', priceJpy: 1500, shippingIncluded: true, url: '' },
  ], c.market)!;
  assert.equal(s.n, 2);
  assert.equal(s.p50, 1550); // (1500 + 1600) ÷ 2
  assert.deepEqual(s.sources.sort(), ['rakuten', 'yahoo']);
});
