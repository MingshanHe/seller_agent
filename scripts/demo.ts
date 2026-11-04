// 不需要任何账号的本地演示：用模拟的外部平台跑一遍完整流程。
import { createHarness } from './harness.ts';

const h = createHarness({ marketPrices: [1800, 2000, 2200, 2400, 2600, 2800, 3000] });
const step = (t: string) => console.log(`\n=== ${t}`);
const showCard = (card: any) => {
  console.log(`【${card.header.title.content}】`);
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (n.tag === 'markdown') console.log(n.content);
    Object.values(n).forEach(walk);
  };
  walk(card.body);
};

step('1. 你在飞书发链接，插件取数，系统生成草稿');
await h.linkAndCapture('https://detail.1688.com/offer/123.html');
showCard(h.lastCard());

step('2. 你点“批准上架”，系统提交到 TikTok');
await h.cardClick(h.actionValue(h.lastCard(), 'approve'));
await h.app.idle();
const product = h.world.created[0];
console.log(JSON.stringify({ title: product.title, skus: product.skus.map((s: any) => ({ seller_sku: s.seller_sku, price: s.price })) }, null, 2));
showCard(h.world.feishuUpdates.at(-1)!.content);

step('3. 买家下单，TikTok 推送订单，系统发采购卡片');
const sellerSku = product.skus[0].seller_sku;
h.world.order = {
  id: 'ord-1', status: 'AWAITING_SHIPMENT', warehouse_id: 'wh-sales',
  rts_sla_time: Math.floor(Date.now() / 1000) + 2 * 86400,
  line_items: [{ id: 'l1', seller_sku: sellerSku, product_id: 'prod-1', sku_id: 'sku-1', product_name: product.title, sale_price: '2280' }],
};
await h.ttsWebhook({ type: 1, tts_notification_id: 'n1', shop_id: 'shop-1', data: { order_id: 'ord-1', order_status: 'AWAITING_SHIPMENT' } });
await h.app.idle();
showCard(h.lastCard());

step('4. 货源涨价，你填新成本，系统重算利润');
const r = await h.cardClick(h.actionValue(h.lastCard(), 'cost_changed'), { new_cost: '28' });
showCard(r.card.data);

step('5. 你在 1688 下完单，点“已下单”');
await h.cardClick(h.actionValue(h.lastCard(), 'purchased'));
console.log('采购任务：', h.store.countTasks());

console.log('\n演示结束。以上外部接口全部是本地模拟。');
