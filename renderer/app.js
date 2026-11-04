// Seller Agent 界面。所有数据都来自主进程，网页内容一律转义后再显示。
'use strict';

const call = (ch, ...args) => window.agent.call(ch, ...args);
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = (n) => `¥${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
const pct = (r) => `${((Number(r) || 0) * 100).toFixed(1)}%`;
const fileUrl = (p) => 'file:///' + encodeURI(String(p).replace(/\\/g, '/')).replace(/#/g, '%23');
const time = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '');

let config = null;
let page = 'home';
let draftFilter = 'all';
let videoFilter = 'all';
let logTab = 'logs';

function toast(text, kind = '') {
  const d = document.createElement('div');
  d.className = kind;
  d.textContent = text;
  $('#toast').appendChild(d);
  setTimeout(() => d.remove(), kind === 'err' ? 8000 : 4500);
}

async function run(fn, okText) {
  try {
    const r = await fn();
    if (okText) toast(okText, 'ok');
    return r;
  } catch (err) {
    toast(err.message || String(err), 'err');
    return undefined;
  }
}

// ---------- 导航 ----------

function show(p) {
  page = p;
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === p));
  $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === p));
  refresh();
}
$$('#nav a').forEach((a) => a.addEventListener('click', () => show(a.dataset.page)));

function accountOptions(sel, selected) {
  const accts = config?.accounts ?? [];
  sel.innerHTML = accts.map((a) => `<option value="${esc(a.id)}" ${a.id === (selected ?? config.defaultAccountId) ? 'selected' : ''}>${esc(a.name)}${a.type === 'creator' ? '（达人号）' : ''}</option>`).join('');
}
const accountName = (id) => config?.accounts.find((a) => a.id === id)?.name ?? (id ? id : '默认账号');

// ---------- 总览 ----------

const STATE_TEXT = { off: ['未配置', ''], connecting: ['连接中', 'warn'], connected: ['已连接', 'ok'], error: ['连接失败', 'bad'] };

async function renderHome() {
  const s = await call('status');
  $('#ver').textContent = `v${s.version} · 日本跨境 POP`;
  const fs = STATE_TEXT[s.feishu] ?? ['未知', ''];
  const stat = (k, v, cls, title = '') => `<div class="stat" title="${esc(title)}"><div class="k">${k}</div><div class="v"><span class="dot ${cls}"></span>${esc(v)}</div></div>`;
  $('#statusCards').innerHTML = [
    stat('运行模式', s.mode === 'api' ? '接口模式' : '半自动模式', s.mode === 'api' ? 'ok' : 'warn', s.mode === 'api' ? '已授权 TikTok 接口' : '没有 AM：系统准备资料，你在卖家中心发布'),
    stat('飞书机器人', fs[0], fs[1], s.feishuError),
    stat('Claude', s.claude ? '已配置' : '未配置', s.claude ? 'ok' : 'bad'),
    stat('图片翻译', s.translator ? '已配置' : '未配置（可选）', s.translator ? 'ok' : ''),
    stat('日本行情', s.market ? '已配置' : '未配置（可选）', s.market ? 'ok' : ''),
    stat('取数', s.capturing ? '正在读取…' : '空闲', s.capturing ? 'warn' : 'ok', s.capturing ?? ''),
  ].join('');

  const kv = (title, obj, names) => `<div class="mt"><b>${title}</b> ` +
    (Object.keys(obj).length ? Object.entries(obj).map(([k, n]) => `<span class="badge">${esc(names[k] ?? k)} ${n}</span>`).join('') : '<span class="muted">暂无</span>') + '</div>';
  $('#counts').innerHTML =
    kv('商品', s.drafts, { awaiting_manual: '待发布', awaiting_approval: '待批准', manual_published: '已发布', rejected: '已放弃', published: '已提交' }) +
    kv('视频', s.videos, { awaiting_info: '待选用途', generating: '生成中', ready: '待发布', published: '已发布', rejected: '已放弃', failed: '失败' }) +
    kv('采购', s.tasks, { awaiting_purchase: '待下单', purchased: '已下单', out_of_stock: '无货' });

  const steps = [
    [s.claude, '在「设置」填 Claude API Key，点“测试 Claude”'],
    [true, '在「账号矩阵」确认账号名称（先用一个账号测试）'],
    [false, '在「账号矩阵」点“登录 1688”，在弹出的浏览器里登录一次'],
    [s.feishu === 'connected', '（可选）在「设置」填飞书 App ID / Secret，飞书后台选择“长连接接收事件和回调”'],
    [false, '粘贴一个 1688 链接试一下，到「商品上架」查看资料包'],
    [false, '在账号的卖家中心发布后，点“我已发布”记录 SKU 对应关系'],
  ];
  $('#checklist').innerHTML = steps.map(([done, t]) => `<li class="${done ? 'done' : ''}">${esc(t)}</li>`).join('');
  $('#sideStatus').innerHTML = `<span class="dot ${fs[1]}"></span> 飞书${esc(fs[0])}<br>${s.mode === 'api' ? '接口模式' : '半自动模式'}`;
  $('#notices').innerHTML = s.notices.length
    ? [...s.notices].reverse().map((n) => `<div><time>${esc(time(n.at))}</time>${n.kind === 'card' ? '📋 ' : ''}${esc(n.text)}</div>`).join('')
    : '<span class="muted">暂无</span>';
}

// 新通知弹出提示（比如取数失败、草稿已生成）。
let lastNotice = Date.now();
async function pollNotices() {
  const s = await call('status').catch(() => null);
  if (!s) return;
  for (const n of s.notices.filter((x) => x.at > lastNotice)) {
    toast(n.kind === 'card' ? `新卡片：${n.text}` : n.text, /失败|出错|不建议|超时|验证/.test(n.text) ? 'err' : '');
  }
  if (s.notices.length) lastNotice = Math.max(lastNotice, s.notices[s.notices.length - 1].at);
}

async function submitLink(input, select, msg) {
  const url = input.value.trim();
  if (!url) return;
  try {
    const r = await call('link:submit', url, select.value);
    msg.className = `msg ${r.ok ? 'ok' : 'err'}`;
    msg.textContent = r.ok ? `${r.message}。大约 1–2 分钟后到「商品上架」查看。` : r.message;
    if (r.ok) input.value = '';
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = e.message;
  }
}
$('#homeLinkBtn').onclick = () => submitLink($('#homeLink'), $('#homeAccount'), $('#homeLinkMsg'));
$('#listLinkBtn').onclick = () => submitLink($('#listLink'), $('#listAccount'), $('#listLinkMsg'));
$('#homeLink').addEventListener('keydown', (e) => e.key === 'Enter' && $('#homeLinkBtn').click());
$('#listLink').addEventListener('keydown', (e) => e.key === 'Enter' && $('#listLinkBtn').click());

// ---------- 商品上架 ----------

const DRAFT_STATUS = {
  awaiting_manual: ['待你发布', 'orange'], awaiting_approval: ['待批准', 'blue'], manual_published: ['已发布', 'green'],
  published: ['已提交', 'green'], rejected: ['已放弃', 'grey'],
};
const CAPTURE_STATUS = { queued: '排队中', sent: '读取中', ok: '已读取', blocked: '需要登录/验证', error: '失败', expired: '超时' };

async function renderListing() {
  const [drafts, caps] = await Promise.all([call('drafts:list'), call('captures:list')]);
  $('#captures').innerHTML = caps.length
    ? `<table><tr><th>时间</th><th>链接</th><th>账号</th><th>状态</th></tr>${caps.map((c) => `<tr><td>${time(c.createdAt)}</td><td class="meta">${esc(c.url)}</td><td>${esc(accountName(c.accountId))}</td><td>${esc(CAPTURE_STATUS[c.status] ?? c.status)}</td></tr>`).join('')}</table>`
    : '<p class="muted">还没有取数任务</p>';

  const list = drafts.filter((d) => draftFilter === 'all' || d._status === draftFilter);
  if (list.length === 0) {
    $('#drafts').innerHTML = '<div class="empty">还没有商品。粘贴一个 1688 链接试试。</div>';
    return;
  }
  $('#drafts').innerHTML = list.map(draftHtml).join('');
}

function draftHtml(d) {
  const [stText, stCls] = DRAFT_STATUS[d._status] ?? [d._status, 'grey'];
  const p = d.pricing;
  const imgs = d.localImages.length ? d.localImages.map(fileUrl) : d.images.map((i) => i.previewUrl).filter((u) => /^https:/.test(u));
  const decision = p.decision === 'reject' ? '<span class="badge red">建议放弃：利润不足</span>' : p.decision === 'review' ? '<span class="badge orange">需要复核</span>' : '';
  const risk = d.risk === 'review' ? '<span class="badge orange">有风险提示</span>' : '';
  const skuRows = d.skus.map((s) => {
    const ps = p.skus.find((x) => x.sourceSkuId === s.sourceSkuId) ?? {};
    return `<tr><td class="mono">${esc(s.sellerSku)}</td><td>${esc(s.specs.map((x) => x.value).join(' / ') || '单规格')}</td><td><b>${yen(s.priceJpy)}</b></td><td>${yen(ps.floorJpy)}</td><td>${esc(s.purchaseCny)} 元</td><td>${yen(ps.profitJpy)}（${pct(ps.marginRate)}）</td></tr>`;
  }).join('');
  const m = p.market;
  const warnings = [...(p.reasons ?? []), ...(d.notes ?? [])];
  const manual = d._status === 'awaiting_manual';
  return `<div class="item ${imgs.length ? '' : 'noimg'}" data-id="${esc(d.id)}">
    ${imgs.length ? `<div class="thumbs"><img src="${esc(imgs[0])}" /><div class="mini">${imgs.slice(1, 4).map((u) => `<img src="${esc(u)}" />`).join('')}</div></div>` : ''}
    <div>
      <div><span class="badge ${stCls}">${esc(stText)}</span>${decision}${risk}<span class="badge">${esc(accountName(d.accountId))}</span><span class="muted small">${time(d.createdAt)}</span></div>
      <h3 class="mt">${esc(d.content.title)}</h3>
      <div class="meta">类目：${esc(d.categoryPath.join(' > '))} · 来源：<a data-ext="${esc(d.source.url)}">${esc(d.source.url)}</a></div>
      <details><summary class="muted">商品描述</summary><div class="desc">${esc(d.content.descriptionParagraphs.join('\n'))}</div></details>
      <table class="mt"><tr><th>Seller SKU</th><th>规格</th><th>售价</th><th>底线</th><th>货源</th><th>预计利润</th></tr>${skuRows}</table>
      <div class="meta mt">佣金 ${pct(p.commissionRate)} · 计费重 ${esc(p.billableGrams)} g · 跨境运费 ${esc(p.crossBorderCny)} 元 · 汇率 ${Number(p.fxCnyJpy).toFixed(2)} ·
        ${m ? `行情 ${m.n} 个同款：P25 ${yen(m.p25)} / P40 ${yen(m.p40)} / 中位 ${yen(m.p50)} / P75 ${yen(m.p75)}` : '没有可比同款'}</div>
      ${warnings.length ? `<div class="notes"><b>需要注意</b><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
      <div class="actions">
        <button class="sm" data-act="copy" data-what="title">复制标题</button>
        <button class="sm" data-act="copy" data-what="desc">复制描述</button>
        <button class="sm" data-act="copy" data-what="skus">复制 SKU 表</button>
        ${d.packageDir ? '<button class="sm" data-act="package">打开资料包</button>' : ''}
        <button class="sm" data-act="seller">打开卖家中心</button>
        ${manual ? `<input class="sm" style="width:150px" placeholder="改价：最低规格日元" data-price />
          <button class="sm" data-act="reprice">更新售价</button>
          <button class="sm primary" data-act="done">我已发布</button>
          <button class="sm danger" data-act="reject">放弃</button>` : ''}
      </div>
    </div>
  </div>`;
}

$('#drafts').addEventListener('click', async (e) => {
  const ext = e.target.closest('[data-ext]');
  if (ext) return call('open:external', ext.dataset.ext);
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const item = btn.closest('.item');
  const id = item.dataset.id;
  const act = btn.dataset.act;
  if (act === 'copy') return run(() => call('draft:copy', id, btn.dataset.what), '已复制');
  if (act === 'package') return run(() => call('draft:openPackage', id));
  if (act === 'seller') return run(() => call('draft:openSeller', id), '已打开卖家中心，标题已复制');
  const map = { reprice: 'manual_reprice', done: 'manual_done', reject: 'manual_reject' };
  if (act === 'reject' && !confirm('确定放弃这个商品？')) return;
  let price;
  if (act === 'reprice') {
    price = Number(String($('[data-price]', item).value).replace(/[,，¥\s]/g, ''));
    if (!(price > 0)) return toast('请填写日元售价', 'err');
  }
  const r = await run(() => call('draft:action', map[act], id, price));
  if (r) toast(r.content, r.type === 'error' ? 'err' : r.type === 'warning' ? '' : 'ok');
  renderListing();
});

$('#draftFilters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-f]');
  if (!b) return;
  draftFilter = b.dataset.f;
  $$('#draftFilters .chip').forEach((c) => c.classList.toggle('on', c === b));
  renderListing();
});
$('#openSourceBrowser').onclick = () => run(() => call('browser:source'));

// ---------- 视频 ----------

const VIDEO_STATUS = {
  awaiting_info: ['待选择用途', 'blue'], generating: ['文案生成中', 'blue'], ready: ['待发布', 'orange'],
  published: ['已发布', 'green'], rejected: ['已放弃', 'grey'], failed: ['生成失败', 'red'],
};

async function renderVideos() {
  const vids = await call('videos:list');
  const list = vids.filter((v) => videoFilter === 'all' || v.status === videoFilter);
  if (list.length === 0) {
    $('#videos').innerHTML = '<div class="empty">还没有视频。点“添加本地视频”，或在飞书把视频发给机器人。</div>';
    return;
  }
  // 编辑中的输入框不要被定时刷新覆盖。
  if ($('#videos').contains(document.activeElement) && document.activeElement.matches('input,textarea,select')) return;
  $('#videos').innerHTML = list.map(videoHtml).join('');
}

function videoHtml(v) {
  const [st, cls] = VIDEO_STATUS[v.status] ?? [v.status, 'grey'];
  const kind = v.kind === 'shoppable' ? '<span class="badge red">挂车</span>' : v.kind === 'exposure' ? '<span class="badge blue">曝光</span>' : '';
  const editable = ['awaiting_info', 'ready', 'failed'].includes(v.status);
  const accts = (config?.accounts ?? []).map((a) => `<option value="${esc(a.id)}" ${a.id === v.accountId ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
  const infoForm = editable ? `
    <div class="row mt">
      <select data-k="account">${accts}</select>
      <input data-k="product" class="grow" placeholder="挂车商品：SKU 编码或关键词（曝光视频留空）" value="${esc(v.productQuery ?? '')}" />
    </div>
    <div class="row mt">
      <input data-k="hint" class="grow" placeholder="运营要点（可空）：卖点、人群、风格" value="${esc(v.hint ?? '')}" />
      <button class="sm" data-act="cover">${v.coverPath ? '换封面' : '加封面图'}</button>
      <button class="sm primary" data-act="shoppable">${v.status === 'ready' ? '重新生成：挂车' : '挂车视频'}</button>
      <button class="sm" data-act="exposure">${v.status === 'ready' ? '重新生成：曝光' : '曝光视频'}</button>
    </div>` : '';
  const ready = v.status === 'ready' || v.status === 'published';
  return `<div class="item" data-id="${esc(v.id)}">
    <div class="thumbs">${v.coverPath ? `<img src="${esc(fileUrl(v.coverPath))}" />` : `<video src="${esc(fileUrl(v.filePath))}" preload="metadata" muted></video>`}</div>
    <div>
      <div><span class="badge ${cls}">${esc(st)}</span>${kind}<span class="badge">${esc(accountName(v.accountId))}</span><span class="muted small">${time(v.createdAt)}</span></div>
      <h3 class="mt">${esc(v.fileName ?? '视频')}</h3>
      ${v.productTitle ? `<div class="meta">挂车商品：${esc(v.productTitle)}</div>` : ''}
      ${ready ? `<textarea data-k="caption" rows="3">${esc(v.caption ?? '')}</textarea>
        <input data-k="tags" style="width:100%" class="mt" value="${esc(v.hashtags.map((h) => '#' + h).join(' '))}" />` : ''}
      ${v.notes.length ? `<div class="notes"><ul>${v.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
      ${infoForm}
      <div class="actions">
        <button class="sm" data-act="show">打开所在文件夹</button>
        ${v.status === 'ready' ? `<button class="sm" data-act="save">保存文案</button>
          <button class="sm" data-act="copy">复制文案</button>
          <button class="sm primary" data-act="assist">辅助发布</button>
          <button class="sm" data-act="done">我已发布</button>` : ''}
        ${editable ? '<button class="sm danger" data-act="reject">放弃</button>' : ''}
      </div>
    </div>
  </div>`;
}

$('#videos').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const item = btn.closest('.item');
  const id = item.dataset.id;
  const val = (k) => $(`[data-k="${k}"]`, item)?.value ?? '';
  const act = btn.dataset.act;
  if (act === 'shoppable' || act === 'exposure') {
    const r = await run(() => call('video:setInfo', id, act, val('product'), val('hint'), val('account')));
    if (r) toast(r.message, r.ok ? 'ok' : 'err');
  } else if (act === 'cover') {
    await run(() => call('video:cover', id));
  } else if (act === 'save' || act === 'copy' || act === 'assist') {
    const tags = val('tags').split(/[\s,，]+/).map((t) => t.replace(/^#+/, '')).filter(Boolean);
    await run(() => call('video:edit', id, val('caption'), tags));
    if (act === 'copy') await run(() => call('copy', `${val('caption')}\n\n${tags.map((t) => '#' + t).join(' ')}`), '已复制');
    if (act === 'save') toast('已保存', 'ok');
    if (act === 'assist') {
      toast('正在打开 TikTok Studio…');
      const r = await run(() => call('video:assist', id));
      if (r) toast(r.message, r.ok ? 'ok' : 'err');
    }
  } else if (act === 'done') {
    const r = await run(() => call('video:done', id));
    if (r) toast(r.message, r.ok ? 'ok' : 'err');
  } else if (act === 'reject') {
    if (confirm('确定放弃这个视频？')) await run(() => call('video:reject', id));
  } else if (act === 'show') {
    await run(() => call('video:show', id));
  }
  renderVideos();
});

$('#videoFilters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-f]');
  if (!b) return;
  videoFilter = b.dataset.f;
  $$('#videoFilters .chip').forEach((c) => c.classList.toggle('on', c === b));
  renderVideos();
});
$('#addVideo').onclick = async () => {
  const r = await run(() => call('video:add', $('#videoAccount').value));
  if (r?.length) toast(`已添加 ${r.length} 个视频，请选择用途`, 'ok');
  renderVideos();
};

// ---------- 订单与货源 ----------

$('#lookupBtn').onclick = async () => {
  const q = $('#lookupQ').value.trim();
  if (!q) return;
  const rows = await run(() => call('lookup', q));
  if (!rows) return;
  $('#lookupResult').innerHTML = rows.length
    ? `<table class="mt"><tr><th>商品</th><th>SKU</th><th>规格</th><th>货源成本</th><th>货源链接</th></tr>${rows.map((r) => `<tr><td>${esc(r.title)}<div class="meta">${esc(r.sourceTitle)}</div></td><td class="mono">${esc(r.sku)}</td><td>${esc(r.spec)}</td><td>${esc(r.cost)} 元</td><td><a data-ext="${esc(r.url)}">打开货源</a> · <a data-src="${esc(r.url)}">在货源浏览器打开</a></td></tr>`).join('')}</table>`
    : `<p class="muted mt">没有找到“${esc(q)}”的货源记录。</p>`;
};
$('#lookupQ').addEventListener('keydown', (e) => e.key === 'Enter' && $('#lookupBtn').click());
$('#lookupResult').addEventListener('click', (e) => {
  const a = e.target.closest('[data-ext]');
  if (a) call('open:external', a.dataset.ext);
  const s = e.target.closest('[data-src]');
  if (s) call('browser:source', s.dataset.src);
});

async function renderOrders() {
  const tasks = await call('tasks:list');
  const ST = { awaiting_purchase: '待下单', purchased: '已下单', out_of_stock: '无货', cancelled: '已取消', cancelled_after_purchase: '下单后取消', manual: '人工处理' };
  $('#tasks').innerHTML = tasks.length
    ? `<table><tr><th>订单</th><th>SKU</th><th>数量</th><th>售价</th><th>状态</th><th>发货期限</th></tr>${tasks.map((t) => `<tr><td class="mono">${esc(t.orderId)}</td><td class="mono">${esc(t.sellerSku)}</td><td>${esc(t.quantity)}</td><td>${yen(t.saleJpy)}</td><td>${esc(ST[t.status] ?? t.status)}</td><td>${t.deadline ? time(t.deadline * 1000) : ''}</td></tr>`).join('')}</table>`
    : '<p class="muted">暂无（半自动模式下请用上面的查询）</p>';
}

// ---------- 账号矩阵 ----------

function renderAccounts() {
  const accts = config?.accounts ?? [];
  $('#accountList').innerHTML = accts.map((a) => `<div class="card" data-id="${esc(a.id)}">
    <div class="head-row" style="margin:0">
      <div><b>${esc(a.name)}</b> <span class="badge ${a.type === 'shop' ? 'red' : 'blue'}">${a.type === 'shop' ? '店铺号' : '达人号'}</span>
        ${a.id === config.defaultAccountId ? '<span class="badge green">默认</span>' : ''}<span class="muted small">${esc(a.note ?? '')}</span></div>
      <div class="row">
        ${a.type === 'shop' ? '<button class="sm" data-act="seller">卖家中心</button>' : ''}
        <button class="sm" data-act="studio">TikTok Studio</button>
        <button class="sm" data-act="tiktok">TikTok</button>
        <button class="sm ghost" data-act="edit">编辑</button>
        ${a.id !== config.defaultAccountId ? '<button class="sm ghost" data-act="default">设为默认</button>' : ''}
        <button class="sm ghost" data-act="clear">清除登录</button>
        ${accts.length > 1 ? '<button class="sm danger" data-act="del">删除</button>' : ''}
      </div>
    </div>
  </div>`).join('');
}

function accountDialog(a) {
  return new Promise((resolve) => {
    const dlg = $('#dlg');
    $('#dlgForm').innerHTML = `<h2>${a ? '编辑账号' : '添加账号'}</h2>
      <div class="field"><label>名称</label><input name="name" required value="${esc(a?.name ?? '')}" placeholder="例如：日本店1号" /></div>
      <div class="field"><label>类型</label><select name="type"><option value="shop" ${a?.type !== 'creator' ? 'selected' : ''}>店铺号（上架+挂车）</option><option value="creator" ${a?.type === 'creator' ? 'selected' : ''}>达人号（只发视频）</option></select></div>
      <div class="field"><label>备注</label><input name="note" value="${esc(a?.note ?? '')}" /></div>
      <p class="muted small">飞书发链接时，在链接前写账号名称就会上架到这个账号。</p>
      <div class="row" style="justify-content:flex-end"><button value="cancel">取消</button><button value="ok" class="primary">保存</button></div>`;
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return resolve(null);
      const f = new FormData($('#dlgForm'));
      resolve({ id: a?.id ?? `acct-${Date.now().toString(36)}`, name: String(f.get('name')).trim() || '未命名账号', type: f.get('type'), note: String(f.get('note') ?? '') });
    };
    dlg.showModal();
  });
}

async function saveAccounts(accounts, defaultAccountId = config.defaultAccountId) {
  const cfg = await call('config:get');
  cfg.accounts = accounts;
  cfg.defaultAccountId = accounts.some((a) => a.id === defaultAccountId) ? defaultAccountId : accounts[0].id;
  await run(() => call('config:save', cfg), '账号已保存');
  await loadConfig();
  renderAccounts();
}

$('#addAccount').onclick = async () => {
  const a = await accountDialog(null);
  if (a) saveAccounts([...config.accounts, a]);
};
$('#accountList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('[data-id]').dataset.id;
  const a = config.accounts.find((x) => x.id === id);
  const act = btn.dataset.act;
  if (act === 'seller' || act === 'studio' || act === 'tiktok') return run(() => call('browser:account', id, act));
  if (act === 'clear') { if (confirm(`清除「${a.name}」的浏览器登录状态？`)) run(() => call('browser:clear', id), '已清除'); return; }
  if (act === 'default') return saveAccounts(config.accounts, id);
  if (act === 'del') { if (confirm(`删除账号「${a.name}」？已有的商品和视频记录不会删除。`)) saveAccounts(config.accounts.filter((x) => x.id !== id)); return; }
  if (act === 'edit') {
    const next = await accountDialog(a);
    if (next) saveAccounts(config.accounts.map((x) => (x.id === id ? next : x)));
  }
});
$('#srcLogin1688').onclick = () => run(() => call('browser:source', 'https://login.1688.com/'));
$('#srcLoginTaobao').onclick = () => run(() => call('browser:source', 'https://login.taobao.com/'));
$('#srcClear').onclick = () => confirm('清除货源浏览器的登录状态？') && run(() => call('browser:clear', null), '已清除');

// ---------- 设置 ----------

const SETTINGS = [
  ['Claude（必填）', [
    ['claude.apiKey', 'API Key', 'password', 'console.anthropic.com 创建。只保存在本机，用 Windows 加密。'],
    ['claude.model', '模型', 'text', '默认 claude-sonnet-5-5'],
  ], [['test:claude', '测试 Claude']]],
  ['飞书机器人（可选，长连接，不需要服务器）', [
    ['feishu.appId', 'App ID', 'text', '飞书开放平台 → 企业自建应用 → 凭证与基础信息'],
    ['feishu.appSecret', 'App Secret', 'password', ''],
    ['feishu.adminOpenIds', '管理员 open_id', 'text', '多人用逗号分隔。先留空，连上后给机器人发“id”，它会回复。'],
    ['feishu.opsChatId', '运营群 chat_id', 'text', '通知和卡片发到这里。同上，发“id”获取。'],
  ], [['test:feishu', '发送测试消息']]],
  ['图片翻译：阿里云百炼（可选）', [
    ['dashscope.apiKey', 'API Key', 'password', '把主图上的中文翻成日文。留空则跳过，并在资料里提示。'],
    ['dashscope.baseUrl', 'Base URL', 'text', '形如 https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com'],
    ['dashscope.model', '模型', 'text', ''],
  ]],
  ['日本行情（可选，用于定价）', [
    ['market.rakutenAppId', '乐天 App ID', 'text', ''],
    ['market.rakutenAccessKey', '乐天 Access Key', 'password', ''],
    ['market.yahooAppId', '雅虎 App ID', 'text', '都留空时按目标利润率定价，标注“无行情依据”。'],
  ]],
  ['汇率', [
    ['fx.cnyJpy', '人民币→日元', 'text', '留空时自动读取实时汇率；填写后固定使用。'],
    ['fx.usdJpy', '美元→日元', 'text', ''],
  ]],
  ['文件位置', [
    ['paths.packageDir', '上架资料包', 'text', '半自动模式下图片、文案、SKU 表放这里。不要放在 OneDrive 同步盘。'],
    ['paths.videoDir', '视频文件', 'text', ''],
  ]],
  ['取数', [
    ['capture.hourlyLimit', '每小时最多取数', 'number', '防止被货源站风控'],
    ['capture.showWindow', '取数时显示浏览器窗口', 'checkbox', '调试用'],
    ['ui.minimizeToTray', '关闭窗口时最小化到托盘', 'checkbox', '保持飞书和取数在后台运行'],
  ]],
  ['TikTok Shop 接口（有 AM / 开发者资格后再填）', [
    ['tiktok.appKey', 'App Key', 'text', '跨境卖家需要客户经理（AM）才能注册 Seller Developer。没有时留空，系统走半自动模式。'],
    ['tiktok.appSecret', 'App Secret', 'password', ''],
    ['tiktok.serviceId', 'Service ID', 'text', ''],
    ['tiktok.port', '本机回调端口', 'number', '授权回调地址填 http://localhost:端口/tts/oauth/callback'],
  ]],
];

const getPath = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
const setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v; };

async function renderSettings() {
  const cfg = await call('config:get');
  $('#settingsForm').innerHTML = SETTINGS.map(([title, fields, tests]) => `<fieldset><legend>${esc(title)}</legend>
    ${fields.map(([path, label, type, hint]) => {
      const v = getPath(cfg, path);
      const input = type === 'checkbox'
        ? `<input type="checkbox" name="${path}" ${v ? 'checked' : ''} style="width:auto" />`
        : `<input type="${type}" name="${path}" value="${esc(v ?? '')}" autocomplete="off" />`;
      return `<div class="field"><label>${esc(label)}</label>${input}${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`;
    }).join('')}
    ${tests ? `<div class="row">${tests.map(([ch, t]) => `<button type="button" data-test="${ch}">${t}</button>`).join('')}</div>` : ''}
  </fieldset>`).join('');
  $('#pricingText').value = await call('pricing:get');
}

$('#settingsForm').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-test]');
  if (!b) return;
  b.disabled = true;
  const r = await run(() => call(b.dataset.test));
  if (r) toast(r, 'ok');
  b.disabled = false;
});

$('#saveSettings').onclick = async () => {
  const cfg = await call('config:get');
  for (const el of $$('#settingsForm [name]')) {
    const v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) || 0 : el.value.trim();
    setPath(cfg, el.name, v);
  }
  const ok = await run(() => call('config:save', cfg), '已保存，引擎已重启');
  if (ok) { await loadConfig(); renderSettings(); }
};
$('#savePricing').onclick = async () => {
  try {
    JSON.parse($('#pricingText').value);
  } catch (e) {
    $('#pricingMsg').className = 'msg err';
    $('#pricingMsg').textContent = `JSON 格式不对：${e.message}`;
    return;
  }
  const ok = await run(() => call('pricing:save', $('#pricingText').value), '定价参数已保存');
  $('#pricingMsg').textContent = ok ? '已保存' : '';
};

// ---------- 日志 ----------

async function renderLogs() {
  if (logTab === 'logs') {
    const lines = await call('logs');
    $('#logBox').innerHTML = lines.map((l) => `<span class="${l.level}">${esc(time(l.at))} ${esc(l.text)}</span>`).join('\n');
  } else {
    const rows = await call('audit');
    $('#logBox').textContent = rows.map((r) => `${time(r.at)}  ${r.kind}  ${r.actor ?? ''}  ${r.detail ?? ''}`).join('\n');
  }
}
$('#logTabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-t]');
  if (!b) return;
  logTab = b.dataset.t;
  $$('#logTabs .chip').forEach((c) => c.classList.toggle('on', c === b));
  renderLogs();
});
$('#openLog').onclick = () => call('open:log');
$('#openData').onclick = () => call('open:dataDir');

// ---------- 刷新 ----------

async function loadConfig() {
  config = await call('config:get');
  for (const sel of ['#homeAccount', '#listAccount', '#videoAccount']) accountOptions($(sel));
}

async function refresh() {
  try {
    if (page === 'home') await renderHome();
    else if (page === 'listing') await renderListing();
    else if (page === 'video') await renderVideos();
    else if (page === 'orders') await renderOrders();
    else if (page === 'accounts') renderAccounts();
    else if (page === 'settings') await renderSettings();
    else if (page === 'logs') await renderLogs();
  } catch (err) {
    console.error(err);
  }
}

// 列表页定时刷新：取数和文案生成在后台进行。设置页不自动刷新，避免覆盖正在填写的内容。
setInterval(() => {
  pollNotices();
  if (['home', 'listing', 'video', 'orders', 'logs'].includes(page)) {
    if (page === 'listing' && document.activeElement?.matches?.('#drafts input')) return;
    refresh();
  }
}, 4000);

(async () => {
  await loadConfig().catch((e) => toast(e.message, 'err'));
  await refresh();
  if (!(await call('status').catch(() => ({}))).claude) toast('第一次使用：请先到「设置」填写 Claude API Key', '');
})();
