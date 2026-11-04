// 出单采购：TikTok 订单进来后，把货源信息推到飞书。1688 下单由人完成。
// 这里的函数可以安全地重复执行：Webhook 收件箱失败后会重试。
import type { PurchaseTask, SkuMapping, Store } from '../db.ts';
import type { FeishuClient } from '../feishu/client.ts';
import { purchaseCard, statusCard } from '../feishu/cards.ts';
import type { PricingConfig } from '../pricing/engine.ts';
import { recomputeProfit } from '../pricing/engine.ts';
import type { FxProvider } from '../pricing/fx.ts';
import type { TikTokClient } from '../tiktok/client.ts';

export interface OrderDeps {
  store: Store;
  tiktok: TikTokClient;
  feishu: FeishuClient;
  fx: FxProvider;
  pricing: PricingConfig;
  opsChatId: string;
  now?: () => number;
}

/** Webhook 用 CANCEL，订单详情用 CANCELLED。 */
const isCancelled = (status: unknown) => status === 'CANCEL' || status === 'CANCELLED';

/** 订单里的官方期限，取最早的一个。 */
export function orderDeadline(order: any): number | null {
  const times = [order.rts_sla_time, order.shipping_due_time].map(Number).filter((t) => t > 0);
  return times.length > 0 ? Math.min(...times) : null;
}

function formatDeadline(ts: number | null): string {
  if (!ts) return '订单未提供，请到后台查看';
  return new Date(ts * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（北京时间）';
}

function groupLines(order: any) {
  const lines = new Map<string, { sellerSku: string; quantity: number; saleJpy: number; productName: string; productId: string; skuId: string }>();
  for (const item of order.line_items ?? []) {
    if (isCancelled(item.display_status)) continue;
    const key = item.seller_sku ?? item.sku_id;
    const existing = lines.get(key);
    if (existing) {
      existing.quantity += 1;
    } else {
      lines.set(key, {
        sellerSku: item.seller_sku ?? '',
        quantity: 1,
        saleJpy: Number(item.sale_price ?? item.original_price ?? 0),
        productName: item.product_name ?? '',
        productId: item.product_id,
        skuId: item.sku_id,
      });
    }
  }
  return lines;
}

async function buildView(deps: OrderDeps, task: PurchaseTask, mapping: SkuMapping, costCny: number, fallbackName = '', warning?: string) {
  const fx = await deps.fx.rate('CNY/JPY');
  // 下单时看中文货源标题更方便。
  const productName = deps.store.draft(mapping.draftId)?.source.title ?? fallbackName;
  const profit = recomputeProfit({
    priceJpy: task.saleJpy,
    purchaseCny: costCny,
    previousPurchaseCny: mapping.purchaseCny,
    previousFixedCostJpy: mapping.fixedCostJpy,
    fxCnyJpy: fx,
    commissionRate: mapping.commissionRate,
  }, deps.pricing);
  return {
    task,
    mapping,
    productName,
    costCny,
    profitJpy: profit.profit,
    marginRate: profit.margin,
    deadlineText: formatDeadline(task.deadline),
    warning,
  };
}

async function cancelTasks(deps: OrderDeps, orderId: string) {
  for (const t of deps.store.tasksForOrder(orderId)) {
    if (deps.store.transitionTask(t.id, 'cancelled', 'awaiting_purchase')) {
      if (t.messageId) {
        await deps.feishu.updateCard(t.messageId, statusCard('订单已取消', 'grey', [`订单 ${orderId} 已取消，不用再下单。`]));
      }
    } else if (deps.store.transitionTask(t.id, 'cancelled_after_purchase', 'purchased')) {
      await deps.feishu.sendText(deps.opsChatId, `订单 ${orderId} 已取消，但你已经在货源下单。请尽快到货源取消或申请退款。`);
    } else if (deps.store.transitionTask(t.id, 'cancelled', 'manual')) {
      await deps.feishu.sendText(deps.opsChatId, `订单 ${orderId} 已取消，这笔没有货源记录的订单不用再处理。`);
    }
  }
}

export async function handleOrderStatus(deps: OrderDeps, shopId: string, orderId: string, status: string) {
  if (isCancelled(status)) return cancelTasks(deps, orderId);
  // ON_HOLD 阶段买家还能取消，等到 AWAITING_SHIPMENT 再采购。
  if (status !== 'AWAITING_SHIPMENT') return;

  const shop = deps.store.shop(shopId);
  if (!shop) throw new Error(`未授权的店铺 ${shopId}`);
  const order = await deps.tiktok.getOrder(shop, orderId);
  // 以订单当前状态为准。Webhook 可能晚到，也可能重试时订单已经变了。
  if (isCancelled(order.status)) return cancelTasks(deps, orderId);
  if (order.status !== 'AWAITING_SHIPMENT') return;

  const deadline = orderDeadline(order);
  const warning = order.is_buyer_request_cancel ? '买家已申请取消，先不要下单' : undefined;

  for (const [key, line] of groupLines(order)) {
    const task = deps.store.purchaseTaskForLine(orderId, key) ?? deps.store.insertPurchaseTask({
      shopId,
      orderId,
      lineKey: key,
      sellerSku: line.sellerSku,
      quantity: line.quantity,
      saleJpy: line.saleJpy,
      deadline,
      productId: line.productId ?? null,
      skuId: line.skuId ?? null,
      warehouseId: order.warehouse_id ?? null,
    });
    // 已经发过卡片就跳过。上次发送失败时 messageId 为空，这里会补发。
    if (!task || task.messageId || task.status !== 'awaiting_purchase') continue;

    const mapping = deps.store.skuMapping(shopId, line.sellerSku);
    if (!mapping) {
      await deps.feishu.sendText(deps.opsChatId, `订单 ${orderId} 的 SKU ${line.sellerSku || line.skuId} 没有货源记录（可能不是本系统上架的），请手动处理。发货期限：${formatDeadline(deadline)}`);
      deps.store.transitionTask(task.id, 'manual', 'awaiting_purchase');
      continue;
    }
    const view = await buildView(deps, task, mapping, mapping.purchaseCny, line.productName, warning);
    const messageId = await deps.feishu.sendCard(deps.opsChatId, purchaseCard(view));
    deps.store.setTaskMessage(task.id, messageId);
    deps.store.audit('order.card', null, { orderId, sellerSku: line.sellerSku });
  }
}

/** 买家发起取消申请时提醒，避免已经在路上的采购。 */
export async function handleCancellationRequest(deps: OrderDeps, orderId: string, cancelStatus: string) {
  if (cancelStatus !== 'CANCELLATION_REQUEST_PENDING') return;
  const open = deps.store.tasksForOrder(orderId).filter((t) => t.status === 'awaiting_purchase');
  const bought = deps.store.tasksForOrder(orderId).filter((t) => t.status === 'purchased');
  if (open.length === 0 && bought.length === 0) return;
  await deps.feishu.sendText(deps.opsChatId, bought.length > 0
    ? `买家申请取消订单 ${orderId}，你已经在货源下单，请到后台处理。`
    : `买家申请取消订单 ${orderId}，先不要到货源下单。`);
}

/** 期限前 12 小时还没确认采购，提醒一次。 */
export async function sendReminders(deps: OrderDeps) {
  const nowSec = Math.floor((deps.now ?? Date.now)() / 1000);
  for (const t of deps.store.tasksDueForReminder(nowSec + 12 * 3600)) {
    await deps.feishu.sendText(deps.opsChatId, `提醒：订单 ${t.orderId} 还没确认下单，发货期限 ${formatDeadline(t.deadline)}。`);
    deps.store.markReminded(t.id);
  }
}

export async function refreshCostCard(deps: OrderDeps, taskId: string, costCny: number) {
  const task = deps.store.purchaseTask(taskId);
  if (!task) throw new Error('采购任务不存在');
  const mapping = deps.store.skuMapping(task.shopId, task.sellerSku);
  if (!mapping) throw new Error('货源记录不存在');
  deps.store.setTaskCost(taskId, costCny);
  const fresh = deps.store.purchaseTask(taskId)!;
  return purchaseCard(await buildView(deps, fresh, mapping, costCny));
}
