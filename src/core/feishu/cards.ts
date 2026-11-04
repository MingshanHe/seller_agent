// 飞书卡片 JSON 2.0。卡片里的文字有一部分来自外部网页，所以先转义再放进 markdown。
import type { SkuMapping, PurchaseTask } from '../db.ts';
import type { ListingDraft, PricingSku } from '../types.ts';

const safe = (t: string) => t.replace(/[\\`*_~[\]<>]/g, (c) => `\\${c}`);
const yen = (n: number) => `¥${Math.round(n).toLocaleString('en-US')}`;
const pct = (r: number) => `${(r * 100).toFixed(1)}%`;

const md = (content: string) => ({ tag: 'markdown', content });
const plain = (content: string) => ({ tag: 'plain_text', content });

function card(title: string, template: string, elements: unknown[]) {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: plain(title), template },
    body: { elements },
  };
}

function button(text: string, type: string, value: Record<string, unknown>, extra: object = {}) {
  return { tag: 'button', text: plain(text), type, behaviors: [{ type: 'callback', value }], ...extra };
}

function row(...items: unknown[]) {
  return {
    tag: 'column_set',
    columns: items.map((el) => ({ tag: 'column', width: 'weighted', weight: 1, elements: [el] })),
  };
}

function skuLine(draft: ListingDraft, p: PricingSku): string {
  const sku = draft.skus.find((s) => s.sourceSkuId === p.sourceSkuId);
  const spec = sku?.specs.map((s) => s.value).join(' / ') || '单规格';
  return `- ${safe(spec)}：售价 **${yen(p.priceJpy)}**，底线 ${yen(p.floorJpy)}，货源 ${p.purchaseCny} 元，总成本 ${yen(p.fixedCostJpy)}，预计利润 ${yen(p.profitJpy)}（${pct(p.marginRate)}）`;
}

export function draftCard(draft: ListingDraft, actionId: string) {
  const p = draft.pricing;
  const m = p.market;
  const reject = p.decision === 'reject';
  const blockedByCheck = draft.listingRoute === 'local' && !draft.check.passed;
  const template = reject || blockedByCheck ? 'red' : p.decision === 'review' || draft.risk === 'review' ? 'orange' : 'blue';

  const elements: unknown[] = [];
  if (draft.previewImageKeys.length > 0) {
    elements.push(row(...draft.previewImageKeys.slice(0, 3).map((k) => ({ tag: 'img', img_key: k, alt: plain('商品图') }))));
  }
  elements.push(md(`**${safe(draft.content.title)}**\n类目：${safe(draft.categoryPath.join(' > '))}\n来源：${safe(draft.source.url)}`));
  elements.push(md(`**商品描述**\n${draft.content.descriptionParagraphs.map(safe).join('\n')}`));
  elements.push(md([
    '**定价**',
    ...p.skus.slice(0, 8).map((s) => skuLine(draft, s)),
    p.skus.length > 8 ? `- 另有 ${p.skus.length - 8} 个规格` : '',
    `佣金 ${pct(p.commissionRate)}，计费重 ${p.billableGrams} 克，跨境运费 ${p.crossBorderCny} 元，汇率 ${p.fxCnyJpy.toFixed(2)}`,
    m ? `行情 ${m.n} 个同款：第 25 百分位 ${yen(m.p25)}，第 40 百分位 ${yen(m.p40)}，中位数 ${yen(m.p50)}，第 75 百分位 ${yen(m.p75)}` : '行情：没有可比同款',
  ].filter(Boolean).join('\n')));

  const warnings = [...p.reasons, ...draft.notes, ...draft.check.failReasons.map((r) => `官方检查未通过：${r}`), ...draft.check.warnings];
  if (warnings.length > 0) elements.push(md(`**需要注意**\n${warnings.map((w) => `- ${safe(w)}`).join('\n')}`));

  const approveValue = { act: 'approve', actionId, draftId: draft.id };
  if (blockedByCheck) {
    elements.push(button('放弃', 'danger', { act: 'reject', actionId, draftId: draft.id }));
  } else {
    elements.push({
      tag: 'form',
      name: 'approve_form',
      elements: [
        { tag: 'input', name: 'price', placeholder: plain('改价（可留空，填最低规格的日元售价）') },
        {
          ...button(reject ? '仍然提交' : '批准上架', reject ? 'danger' : 'primary_filled', { ...approveValue, force: reject }),
          name: 'submit_btn',
          form_action_type: 'submit',
        },
      ],
    });
    elements.push(button('放弃', 'default', { act: 'reject', actionId, draftId: draft.id }));
  }
  return card(reject ? '建议放弃：利润空间不足' : blockedByCheck ? '官方检查未通过' : '待批准上架', template, elements);
}

/** 半自动模式的卡片。标题和描述用纯文本，避免被当成 markdown 改动。 */
export function manualCard(draft: ListingDraft) {
  const p = draft.pricing;
  const reject = p.decision === 'reject';
  const elements: unknown[] = [];
  for (let i = 0; i < draft.previewImageKeys.length; i += 3) {
    elements.push(row(...draft.previewImageKeys.slice(i, i + 3).map((k) => ({ tag: 'img', img_key: k, alt: plain('商品图') }))));
  }
  elements.push({ tag: 'div', text: plain(draft.content.title) });
  elements.push(md([
    '**定价**',
    ...p.skus.slice(0, 8).map((s) => {
      const sku = draft.skus.find((x) => x.sourceSkuId === s.sourceSkuId);
      return `${skuLine(draft, s)}，SKU 编码 \`${sku?.sellerSku ?? ''}\``;
    }),
    p.skus.length > 8 ? `- 另有 ${p.skus.length - 8} 个规格，见资料包` : '',
    `佣金按 ${safe(draft.categoryPath.join(' > '))} 估算为 ${pct(p.commissionRate)}，计费重 ${p.billableGrams} 克，跨境运费 ${p.crossBorderCny} 元，汇率 ${p.fxCnyJpy.toFixed(2)}`,
    p.market ? `行情 ${p.market.n} 个同款：第 25 百分位 ${yen(p.market.p25)}，第 40 百分位 ${yen(p.market.p40)}，中位数 ${yen(p.market.p50)}，第 75 百分位 ${yen(p.market.p75)}` : '行情：没有可比同款',
  ].filter(Boolean).join('\n')));
  const warnings = [...p.reasons, ...draft.notes];
  if (warnings.length > 0) elements.push(md(`**需要注意**\n${warnings.map((w) => `- ${safe(w)}`).join('\n')}`));
  if (draft.packageDir) elements.push({ tag: 'div', text: plain(`资料包：${draft.packageDir}`) });
  elements.push({
    tag: 'form',
    name: 'reprice_form',
    elements: [
      { tag: 'input', name: 'price', placeholder: plain('改价：填最低规格的日元售价') },
      { ...button('更新售价', 'default', { act: 'manual_reprice', draftId: draft.id }), name: 'reprice_btn', form_action_type: 'submit' },
    ],
  });
  elements.push(row(
    button('我已发布', 'primary_filled', { act: 'manual_done', draftId: draft.id }),
    button('放弃', 'default', { act: 'manual_reject', draftId: draft.id }),
  ));
  return card(reject ? '建议放弃：利润空间不足' : '请到卖家中心发布', reject ? 'red' : draft.risk === 'review' || p.decision === 'review' ? 'orange' : 'blue', elements);
}

export function statusCard(title: string, template: string, lines: string[]) {
  return card(title, template, [md(lines.map(safe).join('\n'))]);
}

export interface PurchaseView {
  task: PurchaseTask;
  mapping: SkuMapping;
  productName: string;
  profitJpy: number;
  marginRate: number;
  costCny: number;
  deadlineText: string;
  warning?: string;
}

export function purchaseCard(v: PurchaseView) {
  const { task, mapping } = v;
  return card('新订单：请到货源下单', 'turquoise', [
    md([
      `**${safe(v.productName)}**`,
      `规格：${safe(mapping.specText)}`,
      `数量：**${task.quantity}**`,
      `货源成本：${v.costCny} 元 / 件`,
      `买家实付单价：${yen(task.saleJpy)}，预计单件利润 ${yen(v.profitJpy)}（${pct(v.marginRate)}）`,
      `发货期限：**${v.deadlineText}**`,
      `订单号：${task.orderId}`,
      v.warning ? `**${safe(v.warning)}**` : '',
    ].filter(Boolean).join('\n')),
    {
      tag: 'button',
      text: plain('打开货源'),
      type: 'primary',
      behaviors: [{ type: 'open_url', default_url: mapping.sourceUrl }],
    },
    {
      tag: 'form',
      name: 'cost_form',
      elements: [
        { tag: 'input', name: 'new_cost', placeholder: plain('货源涨价时填新单价（人民币）') },
        {
          ...button('更新成本', 'default', { act: 'cost_changed', taskId: task.id }),
          name: 'cost_btn',
          form_action_type: 'submit',
        },
      ],
    },
    row(
      button('已下单', 'primary_filled', { act: 'purchased', taskId: task.id }),
      button('无货并下架', 'danger', { act: 'out_of_stock', taskId: task.id }),
    ),
  ]);
}
