// 端到端：从飞书发链接，到提交商品，再到出单采购。外部接口全部用模拟世界。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { App } from '../src/core/app.ts';
import { calculateSignature } from '../src/core/feishu/crypto.ts';
import { sendReminders } from '../src/core/orders/flow.ts';
import { ADMIN, CAPTURE_TOKEN, CHAT, createHarness, ENCRYPT_KEY, VERIFY_TOKEN, type Harness } from '../scripts/harness.ts';

const HEALTHY_MARKET = [1800, 2000, 2200, 2400, 2600, 2800, 3000];

const texts = (h: Harness) => h.world.feishuMessages.filter((m) => m.type === 'text').map((m) => m.content.text as string);

async function approve(h: Harness, form: object = {}) {
  const value = h.actionValue(h.lastCard(), 'approve');
  const r = await h.cardClick(value, form);
  await h.app.idle();
  return r;
}

function orderFixture(sellerSku: string, overrides: object = {}) {
  const line = { id: 'l1', seller_sku: sellerSku, product_id: 'prod-1', sku_id: 'sku-1', product_name: 'ステンレス水筒', sale_price: '2280', currency: 'JPY' };
  return {
    id: 'ord-1', status: 'AWAITING_SHIPMENT', warehouse_id: 'wh-sales',
    rts_sla_time: Math.floor(Date.now() / 1000) + 3 * 86400,
    shipping_due_time: Math.floor(Date.now() / 1000) + 2 * 86400,
    line_items: [line, { ...line, id: 'l2' }],
    ...overrides,
  };
}

async function publishedHarness() {
  const h = createHarness({ marketPrices: HEALTHY_MARKET });
  await h.linkAndCapture();
  await approve(h);
  const sellerSku = h.world.created[0].skus[0].seller_sku;
  return { h, sellerSku };
}

const orderEvent = (id = 'n1', status = 'AWAITING_SHIPMENT') => ({
  type: 1, tts_notification_id: id, shop_id: 'shop-1', timestamp: 1,
  data: { order_id: 'ord-1', order_status: status, update_time: 1 },
});

test('主流程：发链接 → 插件取数 → 生成卡片 → 批准 → 提交商品', async () => {
  const h = createHarness({ marketPrices: HEALTHY_MARKET });
  await h.linkAndCapture();

  assert.equal(h.world.created.length, 0, '批准前不能提交');
  const card = h.lastCard();
  assert.equal(card.header.title.content, '待批准上架');
  const body = JSON.stringify(card);
  assert.ok(body.includes('¥2,280'), '卡片要显示售价');
  assert.ok(body.includes('¥2,211'), '卡片要显示底线价');
  assert.ok(body.includes('行情 7 个同款'));

  const toast = await approve(h);
  assert.equal(toast.toast.content, '已批准，正在提交');
  assert.equal(h.world.created.length, 1);

  const p = h.world.created[0];
  assert.equal(p.title, 'ステンレス水筒 500ml 真空二重構造');
  assert.equal(p.category_id, 'cat-3');
  assert.equal(p.main_images.length, 5);
  assert.deepEqual(p.package_weight, { value: '320', unit: 'GRAM' });
  assert.deepEqual(p.skus[0].price, { amount: '2280', currency: 'JPY', sale_price: '2280' });
  assert.deepEqual(p.skus[0].sales_attributes, [{ name: 'カラー', value_name: 'ブルー' }]);
  assert.deepEqual(p.skus[0].inventory, [{ warehouse_id: 'wh-sales', quantity: 20 }]);

  // 模型编造的属性和值被白名单挡掉
  assert.deepEqual(p.product_attributes, [{ id: 'a-brand', values: [{ id: 'v-none', name: 'ノーブランド' }] }]);

  const update = h.world.feishuUpdates.at(-1)!;
  assert.equal(update.content.header.title.content, '已提交审核');
  assert.deepEqual(h.store.countDrafts(), { submitted: 1 });
});

test('模型返回的图片地址只保留页面上真实出现过的', async () => {
  const h = createHarness({ marketPrices: HEALTHY_MARKET });
  await h.linkAndCapture();
  const urls = h.world.feishuMessages.map((m) => JSON.stringify(m.content)).join();
  assert.ok(!urls.includes('evil.example'));
});

test('取数遇到验证码时停止，并通知人工处理', async () => {
  const h = createHarness();
  await h.sendText('https://detail.1688.com/offer/9.html');
  await h.app.idle();
  const res = await h.app.handle({ method: 'GET', path: '/capture/next', query: new URLSearchParams(), headers: { authorization: `Bearer ${CAPTURE_TOKEN}` }, rawBody: '' });
  const { job } = JSON.parse(res.body);
  await h.app.handle({
    method: 'POST', path: '/capture/result', query: new URLSearchParams(),
    headers: { authorization: `Bearer ${CAPTURE_TOKEN}` }, rawBody: JSON.stringify({ jobId: job.id, status: 'blocked' }),
  });
  await h.app.idle();
  assert.ok(texts(h).some((t) => t.includes('人工验证')));
  assert.equal(h.world.claudeCalls, 0);
});

test('插件接口要口令', async () => {
  const h = createHarness();
  const headers = { authorization: 'Bearer wrong' };
  const a = await h.app.handle({ method: 'GET', path: '/capture/next', query: new URLSearchParams(), headers, rawBody: '' });
  const b = await h.app.handle({ method: 'POST', path: '/capture/result', query: new URLSearchParams(), headers, rawBody: '{}' });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
});

test('不支持的网站让用户改发截图', async () => {
  const h = createHarness();
  await h.sendText('https://example.com/item/1');
  await h.app.idle();
  assert.ok(texts(h).some((t) => t.includes('请发商品页截图')));
});

test('非管理员的消息不进入流程', async () => {
  const h = createHarness();
  await h.sendText('https://detail.1688.com/offer/1.html', 'ou_stranger');
  await h.app.idle();
  assert.ok(texts(h)[0].includes('ou_stranger'));
  const res = await h.app.handle({ method: 'GET', path: '/capture/next', query: new URLSearchParams(), headers: { authorization: `Bearer ${CAPTURE_TOKEN}` }, rawBody: '' });
  assert.equal(JSON.parse(res.body).job, null);
});

test('非管理员点批准被拒绝，商品不提交', async () => {
  const h = createHarness({ marketPrices: HEALTHY_MARKET });
  await h.linkAndCapture();
  const r = await h.cardClick(h.actionValue(h.lastCard(), 'approve'), {}, 'ou_stranger');
  await h.app.idle();
  assert.equal(r.toast.type, 'error');
  assert.equal(h.world.created.length, 0);
});

test('重复点批准只提交一次', async () => {
  const h = createHarness({ marketPrices: HEALTHY_MARKET });
  await h.linkAndCapture();
  const value = h.actionValue(h.lastCard(), 'approve');
  await h.cardClick(value);
  const second = await h.cardClick(value);
  await h.app.idle();
  assert.equal(second.toast.type, 'warning');
  assert.equal(h.world.created.length, 1);
});

test('改价：高于底线生效，低于底线被拒绝', async () => {
  const h = createHarness({ marketPrices: HEALTHY_MARKET });
  await h.linkAndCapture();
  const value = h.actionValue(h.lastCard(), 'approve');

  const low = await h.cardClick(value, { price: '1500' });
  assert.equal(low.toast.type, 'error');
  assert.match(low.toast.content, /低于底线价/);
  assert.equal(h.store.action(value.actionId)!.status, 'pending');

  await h.cardClick(value, { price: '¥2,980' });
  await h.app.idle();
  assert.equal(h.world.created[0].skus[0].price.sale_price, '2980');
  assert.ok(Number(h.world.created[0].skus[1].price.sale_price) > 2980);
});

test('定价建议放弃：要明确选择仍然提交', async () => {
  const h = createHarness({ marketPrices: [800, 900, 1000, 1100, 1200, 1300, 1400] });
  await h.linkAndCapture();
  const card = h.lastCard();
  assert.equal(card.header.template, 'red');
  assert.equal(card.header.title.content, '建议放弃：利润空间不足');

  // 伪造不带 force 的点击，也会被代码挡住
  const value = h.actionValue(card, 'approve');
  assert.equal(value.force, true);
  await h.cardClick({ ...value, force: false });
  await h.app.idle();
  assert.equal(h.world.created.length, 0);
  assert.equal(h.world.feishuUpdates.at(-1)!.content.header.title.content, '提交失败');
});

test('定价建议放弃时，确认仍然提交可以通过', async () => {
  const h = createHarness({ marketPrices: [800, 900, 1000, 1100, 1200, 1300, 1400] });
  await h.linkAndCapture();
  await approve(h);
  assert.equal(h.world.created.length, 1);
  assert.ok(h.store.auditEntries().some((e) => e.kind === 'action.approved' && e.detail.patch.force === true));
});

test('官方检查失败：卡片没有批准按钮', async () => {
  const h = createHarness({ marketPrices: HEALTHY_MARKET, listingCheckFails: true });
  await h.linkAndCapture();
  const card = h.lastCard();
  assert.equal(card.header.title.content, '官方检查未通过');
  assert.equal(h.actionValue(card, 'approve'), null);
  assert.ok(JSON.stringify(card).includes('必填属性缺失'));
});

test('文案留有中文时重写一次', async () => {
  const h = createHarness({ marketPrices: HEALTHY_MARKET, chineseFirstPass: true });
  await h.linkAndCapture();
  await approve(h);
  assert.equal(h.world.created[0].title, 'ステンレス水筒 500ml 真空二重構造');
});

test('仿冒货源在调用模型前就被拦下', async () => {
  const h = createHarness({ sourceTitle: '高仿大牌水杯' });
  await h.linkAndCapture();
  assert.ok(texts(h).some((t) => t.includes('不建议上架') && t.includes('仿冒')));
  assert.equal(h.world.feishuMessages.filter((m) => m.type === 'interactive').length, 0);
  assert.equal(h.world.claudeCalls, 1, '只有整理页面那一次');
});

test('全球商品路径：先建全球商品，再用 sale_price 发布到日本', async () => {
  const h = createHarness({ marketPrices: HEALTHY_MARKET, globalPermission: true });
  await h.linkAndCapture();
  await approve(h);
  const [global, publish] = h.world.created;
  assert.equal(global.skus[0].price.currency, 'USD');
  assert.equal(global.skus[0].price.amount, (2280 / 150).toFixed(2));
  const target = publish.publish_target[0];
  assert.equal(target.region, 'JP');
  assert.equal(target.skus[0].price.sale_price, '2280');
  assert.equal(target.skus[0].price.currency, 'JPY');
  assert.ok(!h.world.tiktokCalls.some((c) => c.path.endsWith('listing_check')));
});

test('全球商品：规格值用英文，类目和属性走全球接口，不带 shop_cipher', async () => {
  const h = createHarness({ marketPrices: HEALTHY_MARKET, globalPermission: true });
  await h.linkAndCapture();
  await approve(h);
  const paths = h.world.tiktokCalls.map((c) => c.path);
  assert.ok(paths.includes('/product/202309/global_categories/recommend'));
  assert.ok(paths.includes('/product/202309/categories/cat-3/global_attributes'));
  assert.ok(paths.includes('/product/202309/categories/cat-3/global_rules'));
  assert.ok(!paths.includes('/product/202309/categories/recommend'));
  const global = h.world.created[0];
  assert.deepEqual(global.skus[0].sales_attributes, [{ name: 'カラー', value_name: 'Blue' }]);
  assert.deepEqual(global.skus[0].inventory, [{ global_warehouse_id: 'gwh-1', quantity: 20 }]);
});

for (const status of ['DRAFT', 'FAILED'] as const) {
  test(`全球商品发布状态是 ${status}：卡片显示失败`, async () => {
    const h = createHarness({ marketPrices: HEALTHY_MARKET, globalPermission: true, publishStatus: status });
    await h.linkAndCapture();
    await approve(h);
    const update = h.world.feishuUpdates.at(-1)!;
    assert.equal(update.content.header.title.content, '提交失败');
    assert.ok(JSON.stringify(update.content).includes('gp-1'), '要告诉用户全球商品已创建');
    assert.deepEqual(h.store.countDrafts(), { failed: 1 });
  });
}

test('提交返回 502 时不重试，并提示先去后台确认', async () => {
  const h = createHarness({ marketPrices: HEALTHY_MARKET, createAppliedThen502: true });
  await h.linkAndCapture();
  await approve(h);
  assert.equal(h.world.created.length, 1, '只能提交一次');
  assert.ok(JSON.stringify(h.world.feishuUpdates.at(-1)!.content).includes('不要重复上架'));
});

test('提交时带幂等键', async () => {
  const h = createHarness({ marketPrices: HEALTHY_MARKET });
  await h.linkAndCapture();
  await approve(h);
  const draftId = h.actionValue(h.world.feishuMessages.find((m) => m.type === 'interactive')!.content, 'approve').draftId;
  assert.equal(h.world.created[0].idempotency_key, draftId);
});

test('货源映射在提交前就保存：提交崩溃后订单仍能找回货源', async () => {
  const h = createHarness({ marketPrices: HEALTHY_MARKET, createAppliedThen502: true });
  await h.linkAndCapture();
  await approve(h);
  const sellerSku = h.world.created[0].skus[0].seller_sku;
  assert.ok(h.store.skuMapping('shop-1', sellerSku));
});

test('服务重启：执行中的动作标记失败并告警', async () => {
  const h = createHarness({ marketPrices: HEALTHY_MARKET });
  await h.linkAndCapture();
  const value = h.actionValue(h.lastCard(), 'approve');
  assert.ok(h.app.gate.approve(value.actionId, ADMIN).ok); // 批准了，但进程在 run() 之前崩溃
  await h.app.recover();
  assert.equal(h.store.action(value.actionId)!.status, 'failed');
  assert.ok(texts(h).some((t) => t.includes('没有执行完')));
  assert.equal(h.world.created.length, 0);
});

test('页面文字里找不到的价格要人工核对', async () => {
  const h = createHarness({ marketPrices: HEALTHY_MARKET, captureText: '304不锈钢保温杯 蓝色 ¥99 黑色 ¥120' });
  await h.linkAndCapture();
  const card = h.lastCard();
  assert.equal(card.header.template, 'orange');
  assert.ok(JSON.stringify(card).includes('价格在页面文字里找不到'));
});

test('卡片显示商品描述和货源单价', async () => {
  const h = createHarness({ marketPrices: HEALTHY_MARKET });
  await h.linkAndCapture();
  const body = JSON.stringify(h.lastCard());
  assert.ok(body.includes('真空二重構造のステンレス水筒です'));
  assert.ok(body.includes('货源 18 元'));
});

test('描述含站外联系方式：重写后还有就拦下', async () => {
  const h = createHarness({ marketPrices: HEALTHY_MARKET, descriptionParagraphs: ['ご購入はLINE ID: abc123 まで'] });
  await h.linkAndCapture();
  await approve(h);
  assert.equal(h.world.created.length, 0);
  assert.ok(JSON.stringify(h.world.feishuUpdates.at(-1)!.content).includes('站外联系方式'));
});

test('整理页面失败时告诉用户，不会没有回音', async () => {
  const h = createHarness({ marketPrices: HEALTHY_MARKET });
  (h.world as any).claudeDown = true;
  await h.linkAndCapture();
  assert.ok(texts(h).some((t) => t.includes('上架流程出错')));
});

test('发货仓受限时不用它', async () => {
  const h = createHarness({ marketPrices: HEALTHY_MARKET, warehouseStatus: 'RESTRICTED' });
  await h.linkAndCapture();
  assert.ok(texts(h).some((t) => t.includes('没有可用的发货仓')));
});

test('令牌刷新失败时告警', async () => {
  const h = createHarness();
  const shop = h.store.shop('shop-1')!;
  h.store.saveShop({ ...shop, accessTokenExpireAt: Math.floor(Date.now() / 1000) + 3600 });
  (h.app as any).d.tiktok.o.authUrl = 'https://unreachable.example';
  await h.app.refreshTokens();
  assert.ok(texts(h).some((t) => t.includes('令牌刷新失败')));
});

test('商品状态变化也推送到飞书', async () => {
  const h = createHarness();
  await h.ttsWebhook({ type: 5, tts_notification_id: 'p2', shop_id: 'shop-1', data: { product_id: 'prod-1', status: 'PRODUCT_STATUS_CHANGED', suspended_reason: '违规冻结' } });
  await h.app.idle();
  assert.ok(texts(h).some((t) => t.includes('违规冻结')));
});

test('TikTok 拒绝时卡片显示失败，不会误报成功', async () => {
  const h = createHarness({ marketPrices: HEALTHY_MARKET, tiktokFailsOnCreate: true });
  await h.linkAndCapture();
  await approve(h);
  const update = h.world.feishuUpdates.at(-1)!;
  assert.equal(update.content.header.title.content, '提交失败');
  assert.ok(JSON.stringify(update.content).includes('平台拒绝'));
});

test('出单：推送采购卡片，同一 SKU 合并数量，重复推送只发一张', async () => {
  const { h, sellerSku } = await publishedHarness();
  h.world.order = orderFixture(sellerSku);
  await h.ttsWebhook(orderEvent('n1'));
  await h.ttsWebhook(orderEvent('n1'));
  await h.ttsWebhook(orderEvent('n2'));
  await h.app.idle();

  const cards = h.world.feishuMessages.filter((m) => m.type === 'interactive' && m.content.header.title.content.startsWith('新订单'));
  assert.equal(cards.length, 1);
  const body = JSON.stringify(cards[0].content);
  assert.ok(body.includes('https://detail.1688.com/offer/123.html'));
  assert.ok(body.includes('颜色：蓝色'));
  assert.ok(body.includes('304不锈钢保温杯'));
  assert.ok(body.includes('**2**'), '两件合并');
});

test('出单：ON_HOLD 阶段不提示采购', async () => {
  const { h, sellerSku } = await publishedHarness();
  h.world.order = orderFixture(sellerSku);
  await h.ttsWebhook(orderEvent('n1', 'ON_HOLD'));
  await h.app.idle();
  assert.deepEqual(h.store.countTasks(), {});
});

test('不是本系统上架的 SKU 会提示手动处理', async () => {
  const { h } = await publishedHarness();
  h.world.order = orderFixture('other-sku');
  await h.ttsWebhook(orderEvent());
  await h.app.idle();
  assert.ok(texts(h).some((t) => t.includes('没有货源记录')));
});

test('已下单：任务完成，重复点击无效', async () => {
  const { h, sellerSku } = await publishedHarness();
  h.world.order = orderFixture(sellerSku);
  await h.ttsWebhook(orderEvent());
  await h.app.idle();
  const value = h.actionValue(h.lastCard(), 'purchased');
  const a = await h.cardClick(value);
  const b = await h.cardClick(value);
  assert.equal(a.toast.type, 'success');
  assert.equal(b.toast.type, 'warning');
  assert.deepEqual(h.store.countTasks(), { purchased: 1 });
});

test('无货：下架商品，并提示人工处理订单', async () => {
  const { h, sellerSku } = await publishedHarness();
  h.world.order = orderFixture(sellerSku);
  await h.ttsWebhook(orderEvent());
  await h.app.idle();
  const r = await h.cardClick(h.actionValue(h.lastCard(), 'out_of_stock'));
  await h.app.idle();
  const call = h.world.tiktokCalls.find((c) => c.path.endsWith('/deactivate'))!;
  assert.deepEqual(call.body, { product_ids: ['prod-1'] });
  assert.ok(JSON.stringify(r.card.data).includes('ord-1'));
  assert.deepEqual(h.store.countTasks(), { out_of_stock: 1 });
});

test('货源涨价：重算利润并更新卡片', async () => {
  const { h, sellerSku } = await publishedHarness();
  h.world.order = orderFixture(sellerSku);
  await h.ttsWebhook(orderEvent());
  await h.app.idle();
  const r = await h.cardClick(h.actionValue(h.lastCard(), 'cost_changed'), { new_cost: '28' });
  assert.equal(r.toast.content, '利润已重算');
  const text = JSON.stringify(r.card.data);
  assert.ok(text.includes('28 元'));
  assert.ok(text.includes('¥177'), '2280 × 0.88 − 1829');
});

test('订单取消后更新采购卡片', async () => {
  const { h, sellerSku } = await publishedHarness();
  h.world.order = orderFixture(sellerSku);
  await h.ttsWebhook(orderEvent('n1'));
  await h.app.idle();
  await h.ttsWebhook(orderEvent('n2', 'CANCEL')); // 官方 Webhook 用 CANCEL
  await h.app.idle();
  assert.equal(h.world.feishuUpdates.at(-1)!.content.header.title.content, '订单已取消');
  assert.deepEqual(h.store.countTasks(), { cancelled: 1 });
});

test('已下单后订单被取消：提醒去货源退款', async () => {
  const { h, sellerSku } = await publishedHarness();
  h.world.order = orderFixture(sellerSku);
  await h.ttsWebhook(orderEvent('n1'));
  await h.app.idle();
  await h.cardClick(h.actionValue(h.lastCard(), 'purchased'));
  await h.ttsWebhook(orderEvent('n2', 'CANCEL'));
  await h.app.idle();
  assert.ok(texts(h).some((t) => t.includes('已经在货源下单')));
  assert.deepEqual(h.store.countTasks(), { cancelled_after_purchase: 1 });
});

test('Webhook 说待发货，但订单其实已取消：不生成采购任务', async () => {
  const { h, sellerSku } = await publishedHarness();
  h.world.order = orderFixture(sellerSku, { status: 'CANCELLED' });
  await h.ttsWebhook(orderEvent());
  await h.app.idle();
  assert.deepEqual(h.store.countTasks(), {});
});

test('已取消的订单行不计入数量', async () => {
  const { h, sellerSku } = await publishedHarness();
  const order: any = orderFixture(sellerSku);
  order.line_items[1].display_status = 'CANCELLED';
  h.world.order = order;
  await h.ttsWebhook(orderEvent());
  await h.app.idle();
  assert.ok(JSON.stringify(h.lastCard()).includes('数量：**1**'));
});

test('买家申请取消时提醒先别下单', async () => {
  const { h, sellerSku } = await publishedHarness();
  h.world.order = orderFixture(sellerSku);
  await h.ttsWebhook(orderEvent('n1'));
  await h.app.idle();
  await h.ttsWebhook({ type: 11, tts_notification_id: 'c1', shop_id: 'shop-1', data: { order_id: 'ord-1', cancel_status: 'CANCELLATION_REQUEST_PENDING' } });
  await h.app.idle();
  assert.ok(texts(h).some((t) => t.includes('先不要到货源下单')));
});

test('订单接口失败时不丢单：重试成功后发卡片', async () => {
  const { h, sellerSku } = await publishedHarness();
  h.world.options.orderFetchFailures = 1;
  h.world.order = orderFixture(sellerSku);
  await h.ttsWebhook(orderEvent('n1'));
  await h.app.idle();
  assert.deepEqual(h.store.countTasks(), {});
  assert.equal(h.store.inboxCounts().pending, 1);

  h.store.forceInboxDue();
  await h.app.processInbox();
  assert.deepEqual(h.store.countTasks(), { awaiting_purchase: 1 });
  assert.equal(h.lastCard().header.title.content, '新订单：请到货源下单');
});

test('订单一直失败：第 3 次告警，第 10 次放弃', async () => {
  const { h, sellerSku } = await publishedHarness();
  h.world.options.orderFetchFailures = 100;
  h.world.order = orderFixture(sellerSku);
  await h.ttsWebhook(orderEvent('n1'));
  await h.app.idle();
  for (let i = 0; i < 12; i++) {
    h.store.forceInboxDue();
    await h.app.processInbox();
  }
  const alerts = texts(h).filter((t) => t.startsWith('TikTok 推送处理失败'));
  assert.equal(alerts.length, 2);
  assert.ok(alerts[1].includes('已停止重试'));
  assert.equal(h.store.inboxCounts().dead, 1);
});

test('飞书发卡片失败时会补发，不重复建任务', async () => {
  const { h, sellerSku } = await publishedHarness();
  h.world.order = orderFixture(sellerSku);
  const realFetch = h.world.fetchImpl;
  let failing = true;
  const flaky = async (url: string, init?: RequestInit) => {
    if (failing && url.includes('/im/v1/messages') && init?.method === 'POST') throw new Error('飞书网络错误');
    return realFetch(url, init);
  };
  (h.app as any).d.feishu.o.fetchImpl = flaky;
  await h.ttsWebhook(orderEvent('n1'));
  await h.app.idle();
  assert.deepEqual(h.store.countTasks(), { awaiting_purchase: 1 });
  failing = false;
  h.store.forceInboxDue();
  await h.app.processInbox();
  assert.equal(h.world.feishuMessages.filter((m) => JSON.stringify(m.content).includes('新订单')).length, 1);
});

test('期限临近提醒一次，已下单的不提醒', async () => {
  const { h, sellerSku } = await publishedHarness();
  const soon = Math.floor(Date.now() / 1000) + 3600;
  h.world.order = orderFixture(sellerSku, { rts_sla_time: soon, shipping_due_time: soon + 100 });
  await h.ttsWebhook(orderEvent());
  await h.app.idle();
  await sendReminders(h.app.orders);
  await sendReminders(h.app.orders);
  assert.equal(texts(h).filter((t) => t.startsWith('提醒')).length, 1);
});

test('TikTok Webhook 验签失败返回 401', async () => {
  const h = createHarness();
  const res = await h.app.handle({
    method: 'POST', path: '/tts/webhook', query: new URLSearchParams(),
    headers: { authorization: 'deadbeef' }, rawBody: JSON.stringify(orderEvent()),
  });
  assert.equal(res.status, 401);
});

test('商品审核结果推回飞书', async () => {
  const h = createHarness();
  await h.ttsWebhook({ type: 5, tts_notification_id: 'p1', shop_id: 'shop-1', data: { product_id: 'prod-1', status: 'PRODUCT_AUDIT_FAILURE', suspended_reason: '图片违规' } });
  await h.app.idle();
  assert.ok(texts(h).some((t) => t.includes('prod-1') && t.includes('图片违规')));
});

test('飞书地址验证：校验 token 后返回 challenge', async () => {
  const h = createHarness();
  const call = (token: string) => h.app.handle({
    method: 'POST', path: '/feishu/events', query: new URLSearchParams(), headers: {},
    rawBody: JSON.stringify({ type: 'url_verification', token, challenge: 'abc' }),
  });
  assert.deepEqual(JSON.parse((await call(VERIFY_TOKEN)).body), { challenge: 'abc' });
  assert.equal((await call('wrong')).status, 403);
});

test('飞书加密事件：验签、解密、去重', async () => {
  const h = createHarness();
  const app = new App({ ...(h.app as any).d, config: { ...(h.app as any).d.config, feishuEncryptKey: ENCRYPT_KEY } });

  const iv = randomBytes(16);
  const key = createHash('sha256').update(ENCRYPT_KEY).digest();
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const plain = JSON.stringify({
    schema: '2.0',
    header: { event_id: 'enc-1', token: VERIFY_TOKEN, event_type: 'im.message.receive_v1' },
    event: { sender: { sender_id: { open_id: ADMIN } }, message: { message_id: 'm', chat_id: CHAT, message_type: 'text', content: '{"text":"帮助"}' } },
  });
  const encrypted = Buffer.concat([iv, cipher.update(plain, 'utf8'), cipher.final()]).toString('base64');
  const rawBody = JSON.stringify({ encrypt: encrypted });
  const headers = {
    'x-lark-request-timestamp': '1', 'x-lark-request-nonce': 'n',
    'x-lark-signature': calculateSignature('1', 'n', ENCRYPT_KEY, rawBody),
  };

  const bad = await app.handle({ method: 'POST', path: '/feishu/events', query: new URLSearchParams(), headers: { ...headers, 'x-lark-signature': 'x' }, rawBody });
  assert.equal(bad.status, 401);

  const ok = await app.handle({ method: 'POST', path: '/feishu/events', query: new URLSearchParams(), headers, rawBody });
  assert.equal(ok.status, 200);
  await app.handle({ method: 'POST', path: '/feishu/events', query: new URLSearchParams(), headers, rawBody });
  await app.idle();
  assert.equal(h.world.feishuMessages.length, 1, '重复事件只处理一次');
});

test('店铺授权：state 校验，用过即失效', async () => {
  const h = createHarness();
  await h.sendText('授权');
  await h.app.idle();
  const link = texts(h)[0];
  assert.ok(link.includes('https://services.tiktokshop.com/open/authorize?service_id=svc-1&state='));
  const state = /state=([0-9a-f]+)/.exec(link)![1];
  const call = (s: string) => h.app.handle({
    method: 'GET', path: '/tts/oauth/callback', headers: {}, rawBody: '',
    query: new URLSearchParams({ code: 'c', state: s }),
  });
  assert.equal((await call('forged')).status, 403);
  assert.equal((await call(state)).status, 200);
  assert.equal((await call(state)).status, 403);
  assert.equal(h.store.shop('shop-1')!.accessToken, 'at-1');
});

test('令牌快到期时刷新', async () => {
  const h = createHarness();
  const shop = h.store.shop('shop-1')!;
  await h.app.refreshTokens();
  assert.equal(h.store.shop('shop-1')!.accessToken, 'at-0', '还有 5 天不刷新');
  h.store.saveShop({ ...shop, accessTokenExpireAt: Math.floor(Date.now() / 1000) + 3600 });
  await h.app.refreshTokens();
  assert.equal(h.store.shop('shop-1')!.accessToken, 'at-1');
});

test('群聊 @机器人 的指令也能识别', async () => {
  const h = createHarness();
  await h.sendText('@_user_1 授权');
  await h.app.idle();
  assert.ok(texts(h)[0].includes('services.tiktokshop.com'));
});

test('插件没有回结果时提醒用户，只提醒一次', async () => {
  const h = createHarness();
  await h.sendText('https://detail.1688.com/offer/1.html');
  await h.app.idle();
  const realNow = Date.now;
  const app = new App({ ...(h.app as any).d, now: () => realNow() + 16 * 60_000 });
  await app.expireCaptures();
  await app.expireCaptures();
  assert.equal(texts(h).filter((t) => t.startsWith('取数超时')).length, 1);
});

test('第一次发消息时回复 open_id 和 chat_id', async () => {
  const h = createHarness();
  await h.sendText('你好', 'ou_new');
  await h.app.idle();
  assert.ok(texts(h)[0].includes('FEISHU_ADMIN_OPEN_IDS=ou_new'));
  assert.ok(texts(h)[0].includes(`FEISHU_OPS_CHAT_ID=${CHAT}`));
});

test('管理员发 id 也能查到这两个值', async () => {
  const h = createHarness();
  await h.sendText('id');
  await h.app.idle();
  assert.ok(texts(h)[0].includes(`FEISHU_ADMIN_OPEN_IDS=${ADMIN}`));
});

test('同一条飞书消息换了 event_id 重复推送，只处理一次', async () => {
  const h = createHarness();
  const event = { sender: { sender_id: { open_id: ADMIN } }, message: { message_id: 'same-msg', chat_id: CHAT, message_type: 'text', content: '{"text":"帮助"}' } };
  await h.feishuEvent(event);
  await h.feishuEvent(event);
  await h.app.idle();
  assert.equal(h.world.feishuMessages.length, 1);
});

test('没配 TikTok 时：Webhook 不接受空密钥签名，授权指令给出提示', async () => {
  const h = createHarness();
  const d = (h.app as any).d;
  const app = new App({ ...d, config: { ...d.config, ttsAppKey: '', ttsAppSecret: '', ttsServiceId: '' } });
  const body = JSON.stringify(orderEvent());
  const forged = createHmac('sha256', '').update(body).digest('hex');
  const res = await app.handle({ method: 'POST', path: '/tts/webhook', query: new URLSearchParams(), headers: { authorization: forged }, rawBody: body });
  assert.equal(res.status, 503);
  await app.handle({
    method: 'POST', path: '/feishu/events', query: new URLSearchParams(), headers: {},
    rawBody: JSON.stringify({ schema: '2.0', header: { event_id: 'x', token: VERIFY_TOKEN, event_type: 'im.message.receive_v1' }, event: { sender: { sender_id: { open_id: ADMIN } }, message: { message_id: 'm-auth', chat_id: CHAT, message_type: 'text', content: '{"text":"授权"}' } } }),
  });
  await app.idle();
  assert.ok(texts(h).some((t) => t.includes('还没有配置 TikTok')));
});

test('应用没开全球商品权限时按本地路径上架', async () => {
  const h = createHarness({ marketPrices: HEALTHY_MARKET });
  const real = h.world.fetchImpl;
  (h.app as any).d.tiktok.o.fetchImpl = async (u: string, i?: RequestInit) =>
    u.includes('/seller/202309/permissions')
      ? new Response(JSON.stringify({ code: 105005, message: 'scope not granted' }), { status: 403 })
      : real(u, i);
  await h.linkAndCapture();
  await approve(h);
  assert.equal(h.world.created.length, 1);
  assert.ok(h.world.created[0].save_mode === 'LISTING');
});

test('状态指令返回店铺和数量', async () => {
  const { h } = await publishedHarness();
  await h.sendText('状态');
  await h.app.idle();
  const t = texts(h).at(-1)!;
  assert.ok(t.includes('测试店') && t.includes('submitted'));
});
