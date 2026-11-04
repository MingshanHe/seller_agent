import test from 'node:test';
import assert from 'node:assert/strict';
import { searchMarket, searchRakuten, searchYahoo } from '../src/core/pricing/market.ts';
import { FxProvider } from '../src/core/pricing/fx.ts';

const jsonRes = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status });

test('乐天：支持 formatVersion 2 和旧结构，含运费看 postageFlag', async () => {
  let called = '';
  const items = [{ itemName: 'A', itemPrice: 1980, postageFlag: 0, itemUrl: 'u' }, { item: { itemName: 'B', itemPrice: '2500', postageFlag: 1, itemUrl: 'v' } }, { itemName: 'C', itemPrice: 0 }];
  const fetchImpl = async (u: string) => { called = u; return jsonRes({ items }); };
  const r = await searchRakuten(fetchImpl, { rakutenAppId: 'a', rakutenAccessKey: 'k' }, '水筒 500ml');
  assert.equal(r.length, 2);
  assert.equal(r[0].shippingIncluded, true);
  assert.equal(r[1].shippingIncluded, false);
  assert.ok(called.startsWith('https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701?'));
  assert.ok(called.includes('applicationId=a') && called.includes('accessKey=k') && called.includes('formatVersion=2'));
});

test('雅虎：只有 shipping.code 为 2 才算包邮', async () => {
  const fetchImpl = async () => jsonRes({ hits: [
    { name: 'A', price: 1000, shipping: { code: 1 } },
    { name: 'B', price: 1000, shipping: { code: 2 } },
    { name: 'C', price: 1000, shipping: { code: 3 } },
  ] });
  const r = await searchYahoo(fetchImpl, { yahooAppId: 'y' }, 'x');
  assert.deepEqual(r.map((x) => x.shippingIncluded), [false, true, false]);
});

test('没有密钥就不查，不报错', async () => {
  const fetchImpl = async () => { throw new Error('不该调用'); };
  const r = await searchMarket(fetchImpl, {}, 'x');
  assert.deepEqual(r, { listings: [], errors: [] });
});

test('一个来源失败不影响另一个', async () => {
  const fetchImpl = async (u: string) => u.includes('rakuten') ? jsonRes({}, 429) : jsonRes({ hits: [{ name: 'B', price: 1000 }] });
  const r = await searchMarket(fetchImpl, { rakutenAppId: 'a', rakutenAccessKey: 'k', yahooAppId: 'y' }, 'x');
  assert.equal(r.listings.length, 1);
  assert.match(r.errors[0], /429/);
});

test('汇率：缓存 6 小时，接口失败时沿用旧值，从未成功就报错', async () => {
  let now = 0;
  let mode: 'ok' | 'fail' = 'ok';
  let calls = 0;
  const fetchImpl = async () => { calls++; return mode === 'ok' ? jsonRes({ rates: { JPY: 21 } }) : jsonRes({}, 500); };
  const fx = new FxProvider({ fetchImpl, now: () => now });
  assert.equal(await fx.rate('CNY/JPY'), 21);
  assert.equal(await fx.rate('CNY/JPY'), 21);
  assert.equal(calls, 1);
  now = 7 * 3600 * 1000;
  mode = 'fail';
  assert.equal(await fx.rate('CNY/JPY'), 21);

  const fresh = new FxProvider({ fetchImpl });
  await assert.rejects(fresh.rate('CNY/JPY'));
});

test('汇率超出合理范围时拒绝', async () => {
  const fx = new FxProvider({ fetchImpl: async () => jsonRes({ rates: { JPY: 2100 } }) });
  await assert.rejects(fx.rate('CNY/JPY'), /合理范围/);
});

test('固定汇率优先', async () => {
  const fx = new FxProvider({ fetchImpl: async () => { throw new Error('不该调用'); }, fixed: { 'CNY/JPY': 20.5 } });
  assert.equal(await fx.rate('CNY/JPY'), 20.5);
});
