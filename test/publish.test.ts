import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublishable } from '../src/core/listing/publish.ts';
import { loadPricing } from '../scripts/harness.ts';
import type { ListingDraft } from '../src/core/types.ts';

const c = loadPricing();
const NOW = 1_800_000_000_000;

function draft(overrides: Partial<ListingDraft> = {}, priceJpy = 2280): ListingDraft {
  return {
    id: 'd', shopId: 's', risk: 'pass', listingRoute: 'local', createdAt: NOW,
    check: { passed: true, failReasons: [], warnings: [] },
    content: { title: 'ステンレス水筒', descriptionParagraphs: ['真空二重構造です。'] },
    skus: [{ sellerSku: 'a-1', sourceSkuId: '1', specs: [], priceJpy, purchaseCny: 18, stock: 20 }],
    pricing: {
      decision: 'ok', reasons: [], commissionRate: 0.09, fxCnyJpy: 21, billableGrams: 320, crossBorderCny: 36, market: null,
      skus: [{ sourceSkuId: '1', purchaseCny: 18, fixedCostJpy: 1614, floorJpy: 2211, priceJpy, profitJpy: 392, marginRate: 0.17 }],
    },
    ...overrides,
  } as unknown as ListingDraft;
}

test('正常草稿可以提交', () => {
  assert.doesNotThrow(() => assertPublishable(draft(), false, c, NOW));
});

test('被改低的售价过不了提交检查', () => {
  assert.throws(() => assertPublishable(draft({}, 2000), false, c, NOW), /低于底线/);
});

test('越过 ¥10,000 后按含税底线检查', () => {
  const d = draft({}, 10080);
  d.pricing.skus[0].fixedCostJpy = 7291;
  d.pricing.skus[0].floorJpy = 9988;
  assert.throws(() => assertPublishable(d, false, c, NOW), /低于底线/);
});

test('超过 3 天的草稿要重新生成', () => {
  assert.throws(() => assertPublishable(draft({ createdAt: NOW - 4 * 86400_000 }), false, c, NOW), /超过 3 天/);
});

test('风险拦截、官方检查失败、建议放弃都过不了', () => {
  assert.throws(() => assertPublishable(draft({ risk: 'block' }), false, c, NOW), /风险规则/);
  assert.throws(() => assertPublishable(draft({ check: { passed: false, failReasons: ['x'], warnings: [] } }), true, c, NOW), /官方检查/);
  const reject = draft();
  reject.pricing.decision = 'reject';
  assert.throws(() => assertPublishable(reject, false, c, NOW), /建议放弃/);
  assert.doesNotThrow(() => assertPublishable(reject, true, c, NOW));
});

test('规格文字里的中文和联系方式也要拦', () => {
  const d = draft();
  d.skus[0].specs = [{ name: 'カラー', value: '蓝色', ascii: 'Blue' }];
  assert.throws(() => assertPublishable(d, false, c, NOW), /中文字/);
  d.skus[0].specs = [{ name: 'カラー', value: 'LINE ID: abc', ascii: 'Blue' }];
  assert.throws(() => assertPublishable(d, false, c, NOW), /站外联系方式/);
});
