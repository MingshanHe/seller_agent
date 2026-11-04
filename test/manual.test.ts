// 半自动模式：没有 TikTok 授权时，只准备资料，不调用任何 TikTok 接口。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHarness, type Harness } from '../scripts/harness.ts';

const MARKET = [1800, 2000, 2200, 2400, 2600, 2800, 3000];
const texts = (h: Harness) => h.world.feishuMessages.filter((m) => m.type === 'text').map((m) => m.content.text as string);
const manual = () => createHarness({ marketPrices: MARKET }, { noShop: true });

async function ready() {
  const h = manual();
  await h.linkAndCapture();
  const card = h.lastCard();
  const dir = /资料包：([^"]+)/.exec(JSON.stringify(card))![1].replace(/\\\\/g, '\\');
  return { h, card, dir };
}

test('没有授权店铺时走半自动：生成卡片和资料，不调用 TikTok', async () => {
  const { h, card } = await ready();
  assert.equal(card.header.title.content, '请到卖家中心发布');
  assert.equal(h.world.tiktokCalls.length, 0);
  const body = JSON.stringify(card);
  assert.ok(body.includes('¥2,280'));
  assert.ok(body.includes('Kitchenware'));
  assert.ok(texts(h).some((t) => t.includes('ステンレス水筒') && t.includes('真空二重構造のステンレス水筒です')));
});

test('资料包里有图片、文字和规格表', async () => {
  const { dir } = await ready();
  const files = readdirSync(dir);
  assert.ok(files.includes('01-translated.jpg'), files.join());
  assert.ok(files.includes('02.jpg'));
  const listing = readFileSync(join(dir, 'listing.txt'), 'utf8');
  assert.ok(listing.includes('ステンレス水筒'));
  assert.ok(listing.includes('¥2280'));
  assert.ok(listing.includes('detail.1688.com'));
  const csv = readFileSync(join(dir, 'skus.csv'), 'utf8');
  assert.equal(csv.charCodeAt(0), 0xfeff, 'Excel 需要 BOM');
  assert.ok(csv.includes('ブルー') && csv.includes('2380'));
});

test('改价：更新卡片和资料包，低于底线被拒绝', async () => {
  const { h, card, dir } = await ready();
  const value = h.actionValue(card, 'manual_reprice');
  const low = await h.cardClick(value, { price: '1500' });
  assert.equal(low.toast.type, 'error');
  const ok = await h.cardClick(value, { price: '2980' });
  assert.ok(JSON.stringify(ok.card.data).includes('¥2,980'));
  assert.ok(readFileSync(join(dir, 'listing.txt'), 'utf8').includes('¥2980'));
});

test('我已发布：记录货源，之后能按 SKU 编码查到', async () => {
  const { h, card } = await ready();
  const done = h.actionValue(card, 'manual_done');
  const a = await h.cardClick(done);
  const b = await h.cardClick(done);
  assert.equal(a.toast.type, 'success');
  assert.equal(b.toast.type, 'warning');
  const code = /SKU 编码 `([^`]+)`/.exec(JSON.stringify(card).replace(/\\n/g, ' '))![1];
  await h.sendText(code);
  await h.app.idle();
  const reply = texts(h).at(-1)!;
  assert.ok(reply.includes('detail.1688.com/offer/123.html'));
  assert.ok(reply.includes('颜色：蓝色'));
  assert.ok(reply.includes('18 元'));
});

test('按关键词查货源', async () => {
  const { h } = await ready();
  await h.sendText('货源 保温杯');
  await h.app.idle();
  assert.ok(texts(h).at(-1)!.includes('detail.1688.com/offer/123.html'));
  await h.sendText('货源 不存在的东西');
  await h.app.idle();
  assert.ok(texts(h).at(-1)!.includes('没有找到'));
});

test('非管理员不能操作半自动卡片', async () => {
  const { h, card } = await ready();
  const r = await h.cardClick(h.actionValue(card, 'manual_done'), {}, 'ou_stranger');
  assert.equal(r.toast.type, 'error');
  assert.deepEqual(h.store.countDrafts(), { awaiting_manual: 1 });
});

test('放弃后不能再标记发布', async () => {
  const { h, card } = await ready();
  await h.cardClick(h.actionValue(card, 'manual_reject'));
  const r = await h.cardClick(h.actionValue(card, 'manual_done'));
  assert.equal(r.toast.type, 'warning');
  assert.deepEqual(h.store.countDrafts(), { rejected: 1 });
});

test('仿冒货源在半自动模式下同样被拦', async () => {
  const h = createHarness({ sourceTitle: '高仿大牌水杯' }, { noShop: true });
  await h.linkAndCapture();
  assert.ok(texts(h).some((t) => t.includes('不建议上架')));
  assert.equal(h.world.feishuMessages.filter((m) => m.type === 'interactive').length, 0);
});

test('利润不足时卡片标红', async () => {
  const h = createHarness({ marketPrices: [800, 900, 1000, 1100, 1200, 1300, 1400] }, { noShop: true });
  await h.linkAndCapture();
  assert.equal(h.lastCard().header.template, 'red');
});

test('授权店铺后自动回到接口模式', async () => {
  const h = createHarness({ marketPrices: MARKET });
  await h.linkAndCapture();
  assert.equal(h.lastCard().header.title.content, '待批准上架');
  assert.ok(h.world.tiktokCalls.length > 0);
});

test('资料包路径不用猜：文件夹确实存在', async () => {
  const { dir } = await ready();
  assert.ok(existsSync(dir));
});
