// SQLite 存储。单店试运行足够用，多店后可以换成 PostgreSQL。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ActionRow, ActionStatus, ActionType, ListingDraft, Shop } from './types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shops (
  id TEXT PRIMARY KEY, cipher TEXT NOT NULL, name TEXT, region TEXT,
  access_token TEXT NOT NULL, access_token_expire_at INTEGER NOT NULL,
  refresh_token TEXT NOT NULL, refresh_token_expire_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS seen_events (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS capture_jobs (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, chat_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, status TEXT NOT NULL,
  json TEXT NOT NULL, created_at INTEGER NOT NULL, message_id TEXT, chat_id TEXT
);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, shop_id TEXT NOT NULL, payload TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
  decided_by TEXT, decided_at INTEGER, result TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sku_map (
  seller_sku TEXT NOT NULL, shop_id TEXT NOT NULL, draft_id TEXT NOT NULL,
  source_url TEXT NOT NULL, spec_text TEXT NOT NULL, purchase_cny REAL NOT NULL,
  fixed_cost_jpy INTEGER NOT NULL, commission_rate REAL NOT NULL,
  product_id TEXT, sku_id TEXT, warehouse_id TEXT,
  PRIMARY KEY (shop_id, seller_sku)
);
CREATE TABLE IF NOT EXISTS purchase_tasks (
  id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, order_id TEXT NOT NULL, line_key TEXT NOT NULL,
  seller_sku TEXT NOT NULL, quantity INTEGER NOT NULL, sale_jpy REAL NOT NULL,
  deadline INTEGER, status TEXT NOT NULL, message_id TEXT, reminded INTEGER NOT NULL DEFAULT 0,
  purchase_cny REAL, created_at INTEGER NOT NULL,
  product_id TEXT, sku_id TEXT, warehouse_id TEXT,
  UNIQUE (order_id, line_key)
);
CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT, kind TEXT NOT NULL, detail TEXT
);
CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'pending',
  status TEXT NOT NULL, file_path TEXT NOT NULL, cover_path TEXT, file_name TEXT,
  hint TEXT, product_query TEXT, draft_id TEXT, product_title TEXT,
  caption TEXT, hashtags TEXT, notes TEXT,
  chat_id TEXT, message_id TEXT, created_at INTEGER NOT NULL, published_at INTEGER
);
`;

/** 旧库升级：后加的列。列已存在时 ALTER 会报错，忽略即可。 */
const MIGRATIONS = [
  `ALTER TABLE capture_jobs ADD COLUMN account_id TEXT`,
];

export type VideoKind = 'pending' | 'shoppable' | 'exposure';
export type VideoStatus = 'awaiting_info' | 'generating' | 'ready' | 'published' | 'rejected' | 'failed';

export interface VideoRow {
  id: string;
  accountId: string;
  kind: VideoKind;
  status: VideoStatus;
  filePath: string;
  coverPath: string | null;
  fileName: string | null;
  hint: string | null;
  productQuery: string | null;
  draftId: string | null;
  productTitle: string | null;
  caption: string | null;
  hashtags: string[];
  notes: string[];
  chatId: string | null;
  messageId: string | null;
  createdAt: number;
  publishedAt: number | null;
}

const toVideo = (r: any): VideoRow => ({
  id: r.id, accountId: r.account_id, kind: r.kind, status: r.status, filePath: r.file_path,
  coverPath: r.cover_path, fileName: r.file_name, hint: r.hint, productQuery: r.product_query,
  draftId: r.draft_id, productTitle: r.product_title, caption: r.caption,
  hashtags: r.hashtags ? JSON.parse(r.hashtags) : [], notes: r.notes ? JSON.parse(r.notes) : [],
  chatId: r.chat_id, messageId: r.message_id, createdAt: r.created_at, publishedAt: r.published_at,
});

export interface SkuMapping {
  sellerSku: string;
  shopId: string;
  draftId: string;
  sourceUrl: string;
  specText: string;
  purchaseCny: number;
  fixedCostJpy: number;
  commissionRate: number;
  productId: string | null;
  skuId: string | null;
  warehouseId: string | null;
}

export interface PurchaseTask {
  id: string;
  shopId: string;
  orderId: string;
  sellerSku: string;
  quantity: number;
  saleJpy: number;
  deadline: number | null;
  status: 'awaiting_purchase' | 'purchased' | 'out_of_stock' | 'cancelled' | 'cancelled_after_purchase' | 'manual';
  messageId: string | null;
  reminded: number;
  purchaseCny: number | null;
  productId: string | null;
  skuId: string | null;
  warehouseId: string | null;
}

const toTask = (r: any): PurchaseTask => ({
  id: r.id, shopId: r.shop_id, orderId: r.order_id, sellerSku: r.seller_sku,
  quantity: r.quantity, saleJpy: r.sale_jpy, deadline: r.deadline, status: r.status,
  messageId: r.message_id, reminded: r.reminded, purchaseCny: r.purchase_cny,
  productId: r.product_id, skuId: r.sku_id, warehouseId: r.warehouse_id,
});

const toAction = (r: any): ActionRow => ({
  id: r.id, type: r.type, shopId: r.shop_id, payload: JSON.parse(r.payload), status: r.status,
  decidedBy: r.decided_by, result: r.result ? JSON.parse(r.result) : null,
});

export class Store {
  private db: DatabaseSync;
  private now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    for (const sql of MIGRATIONS) {
      try { this.db.exec(sql); } catch { /* 已升级过 */ }
    }
    this.now = now;
  }

  close() { this.db.close(); }

  audit(kind: string, actor: string | null, detail: unknown) {
    this.db.prepare('INSERT INTO audit_log (at, actor, kind, detail) VALUES (?, ?, ?, ?)')
      .run(this.now(), actor, kind, JSON.stringify(detail));
  }

  auditEntries(): { kind: string; actor: string | null; detail: any }[] {
    return (this.db.prepare('SELECT kind, actor, detail FROM audit_log ORDER BY id').all() as any[])
      .map((r) => ({ kind: r.kind, actor: r.actor, detail: JSON.parse(r.detail) }));
  }

  /** 第一次见到返回 true，重复事件返回 false。 */
  markSeen(eventId: string): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO seen_events (id, at) VALUES (?, ?)').run(eventId, this.now());
    return Number(r.changes) === 1;
  }

  saveShop(s: Shop) {
    this.db.prepare(`INSERT INTO shops VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET cipher=excluded.cipher, name=excluded.name, region=excluded.region,
      access_token=excluded.access_token, access_token_expire_at=excluded.access_token_expire_at,
      refresh_token=excluded.refresh_token, refresh_token_expire_at=excluded.refresh_token_expire_at`)
      .run(s.id, s.cipher, s.name, s.region, s.accessToken, s.accessTokenExpireAt, s.refreshToken, s.refreshTokenExpireAt);
  }

  private toShop(r: any): Shop {
    return {
      id: r.id, cipher: r.cipher, name: r.name, region: r.region,
      accessToken: r.access_token, accessTokenExpireAt: r.access_token_expire_at,
      refreshToken: r.refresh_token, refreshTokenExpireAt: r.refresh_token_expire_at,
    };
  }

  shop(id: string): Shop | null {
    const r = this.db.prepare('SELECT * FROM shops WHERE id = ?').get(id);
    return r ? this.toShop(r) : null;
  }

  shops(): Shop[] {
    return this.db.prepare('SELECT * FROM shops').all().map((r) => this.toShop(r));
  }

  addOauthState(state: string) {
    this.db.prepare('INSERT OR REPLACE INTO oauth_states VALUES (?, ?)').run(state, this.now());
  }

  /** 用一次就作废，1 小时内有效。 */
  consumeOauthState(state: string): boolean {
    const r = this.db.prepare('DELETE FROM oauth_states WHERE state = ? AND at >= ?').run(state, this.now() - 3600_000);
    return Number(r.changes) === 1;
  }

  // ---------- 取数任务 ----------

  enqueueCapture(url: string, chatId: string, accountId: string | null = null): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO capture_jobs (id, url, chat_id, created_at, account_id) VALUES (?,?,?,?,?)').run(id, url, chatId, this.now(), accountId);
    return id;
  }

  /** 一次只发一个取数任务。 */
  nextCapture(): { id: string; url: string } | null {
    const r = this.db.prepare(`SELECT id, url FROM capture_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1`).get() as any;
    if (!r) return null;
    this.db.prepare(`UPDATE capture_jobs SET status = 'sent' WHERE id = ?`).run(r.id);
    return { id: r.id, url: r.url };
  }

  finishCapture(id: string, status: string): { chatId: string; url: string; accountId: string | null } | null {
    const r = this.db.prepare('SELECT chat_id, url, account_id FROM capture_jobs WHERE id = ?').get(id) as any;
    if (!r) return null;
    this.db.prepare('UPDATE capture_jobs SET status = ? WHERE id = ?').run(status, id);
    return { chatId: r.chat_id, url: r.url, accountId: r.account_id ?? null };
  }

  recentCaptures(limit = 30): { id: string; url: string; status: string; createdAt: number; accountId: string | null }[] {
    return (this.db.prepare('SELECT id, url, status, created_at, account_id FROM capture_jobs ORDER BY created_at DESC LIMIT ?').all(limit) as any[])
      .map((r) => ({ id: r.id, url: r.url, status: r.status, createdAt: r.created_at, accountId: r.account_id ?? null }));
  }

  /** 取出超时的任务并标记为 expired，每个任务只返回一次。 */
  staleCaptures(beforeMs: number): { chatId: string; url: string }[] {
    const rows = this.db.prepare(`SELECT id, chat_id, url FROM capture_jobs
      WHERE status IN ('queued', 'sent') AND created_at < ?`).all(beforeMs) as any[];
    for (const r of rows) this.db.prepare(`UPDATE capture_jobs SET status = 'expired' WHERE id = ?`).run(r.id);
    return rows.map((r) => ({ chatId: r.chat_id, url: r.url }));
  }

  // ---------- 草稿 ----------

  saveDraft(d: ListingDraft, status = 'awaiting_approval') {
    this.db.prepare(`INSERT INTO drafts (id, shop_id, status, json, created_at) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, json = excluded.json`)
      .run(d.id, d.shopId, status, JSON.stringify(d), this.now());
  }

  draft(id: string): (ListingDraft & { _status: string; _messageId: string | null; _chatId: string | null }) | null {
    const r = this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as any;
    return r ? { ...JSON.parse(r.json), _status: r.status, _messageId: r.message_id, _chatId: r.chat_id } : null;
  }

  setDraftStatus(id: string, status: string) {
    this.db.prepare('UPDATE drafts SET status = ? WHERE id = ?').run(status, id);
  }

  /** 只有处在 from 状态的草稿才能转状态，重复点击只有第一次成功。 */
  transitionDraft(id: string, from: string, to: string): boolean {
    const r = this.db.prepare('UPDATE drafts SET status = ? WHERE id = ? AND status = ?').run(to, id, from);
    return Number(r.changes) === 1;
  }

  /** 按商品文字搜草稿，用于手动查货源。 */
  searchDrafts(keyword: string, limit = 5): (ListingDraft & { _status: string })[] {
    const pattern = `%${keyword.replace(/[\\%_]/g, '\\$&')}%`;
    return (this.db.prepare(`SELECT json, status FROM drafts WHERE json LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?`).all(pattern, limit) as any[])
      .map((r) => ({ ...JSON.parse(r.json), _status: r.status }));
  }

  setDraftMessage(id: string, chatId: string, messageId: string) {
    this.db.prepare('UPDATE drafts SET chat_id = ?, message_id = ? WHERE id = ?').run(chatId, messageId, id);
  }

  /** 桌面端列表用。 */
  listDrafts(limit = 100): (ListingDraft & { _status: string })[] {
    return (this.db.prepare('SELECT json, status FROM drafts ORDER BY created_at DESC LIMIT ?').all(limit) as any[])
      .map((r) => ({ ...JSON.parse(r.json), _status: r.status }));
  }

  listTasks(limit = 100): PurchaseTask[] {
    return this.db.prepare('SELECT * FROM purchase_tasks ORDER BY created_at DESC LIMIT ?').all(limit).map(toTask);
  }

  recentAudit(limit = 200): { at: number; kind: string; actor: string | null; detail: string }[] {
    return this.db.prepare('SELECT at, kind, actor, detail FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) as any[];
  }

  // ---------- 视频 ----------

  insertVideo(v: { accountId: string; filePath: string; coverPath: string | null; fileName: string | null; chatId: string | null }): VideoRow {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO videos (id, account_id, status, file_path, cover_path, file_name, chat_id, created_at)
      VALUES (?, ?, 'awaiting_info', ?, ?, ?, ?, ?)`).run(id, v.accountId, v.filePath, v.coverPath, v.fileName, v.chatId, this.now());
    return this.video(id)!;
  }

  video(id: string): VideoRow | null {
    const r = this.db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
    return r ? toVideo(r) : null;
  }

  listVideos(limit = 100): VideoRow[] {
    return this.db.prepare('SELECT * FROM videos ORDER BY created_at DESC LIMIT ?').all(limit).map(toVideo);
  }

  updateVideo(id: string, patch: Partial<Omit<VideoRow, 'id' | 'createdAt'>>) {
    const cols: Record<string, string> = {
      accountId: 'account_id', kind: 'kind', status: 'status', filePath: 'file_path', coverPath: 'cover_path',
      fileName: 'file_name', hint: 'hint', productQuery: 'product_query', draftId: 'draft_id', productTitle: 'product_title',
      caption: 'caption', hashtags: 'hashtags', notes: 'notes', chatId: 'chat_id', messageId: 'message_id', publishedAt: 'published_at',
    };
    const sets: string[] = [];
    const values: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = cols[k];
      if (!col) continue;
      sets.push(`${col} = ?`);
      values.push(Array.isArray(v) ? JSON.stringify(v) : (v ?? null));
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE videos SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }

  /** 状态从 from 转到 to，重复点击只有第一次成功。 */
  transitionVideo(id: string, from: VideoStatus[], to: VideoStatus): boolean {
    const r = this.db.prepare(`UPDATE videos SET status = ? WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`).run(to, id, ...from);
    return Number(r.changes) === 1;
  }

  countVideos(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM videos GROUP BY status').all() as any[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  countDrafts(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM drafts GROUP BY status').all() as any[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  // ---------- 待审批动作 ----------

  insertAction(type: ActionType, shopId: string, payload: unknown, key: string): ActionRow {
    const existing = this.db.prepare('SELECT * FROM actions WHERE idempotency_key = ?').get(key);
    if (existing) return toAction(existing);
    const id = randomUUID();
    this.db.prepare(`INSERT INTO actions (id, type, shop_id, payload, idempotency_key, status, created_at)
      VALUES (?,?,?,?,?,'pending',?)`).run(id, type, shopId, JSON.stringify(payload), key, this.now());
    return this.action(id)!;
  }

  action(id: string): ActionRow | null {
    const r = this.db.prepare('SELECT * FROM actions WHERE id = ?').get(id);
    return r ? toAction(r) : null;
  }

  /** 原子地从 pending 转出，重复点击只有第一次成功。 */
  claimAction(id: string, next: ActionStatus, operator: string): boolean {
    const r = this.db.prepare(`UPDATE actions SET status = ?, decided_by = ?, decided_at = ?
      WHERE id = ? AND status = 'pending'`).run(next, operator, this.now(), id);
    return Number(r.changes) === 1;
  }

  mergeActionPayload(id: string, patch: object) {
    const action = this.action(id);
    if (!action) return;
    this.db.prepare('UPDATE actions SET payload = ? WHERE id = ?').run(JSON.stringify({ ...(action.payload as object), ...patch }), id);
  }

  finishAction(id: string, status: ActionStatus, result: unknown) {
    this.db.prepare('UPDATE actions SET status = ?, result = ? WHERE id = ?').run(status, JSON.stringify(result ?? null), id);
  }

  /** 服务重启时还在执行的动作，结果不确定。 */
  runningActions(): ActionRow[] {
    return this.db.prepare(`SELECT * FROM actions WHERE status = 'running'`).all().map(toAction);
  }

  // ---------- Webhook 收件箱 ----------

  /** 先落库再回 200，处理失败或服务重启都不会丢。重复推送返回 false。 */
  addToInbox(id: string, payload: string): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO inbox (id, payload, next_at, created_at) VALUES (?, ?, ?, ?)')
      .run(id, payload, this.now(), this.now());
    return Number(r.changes) === 1;
  }

  dueInbox(): { id: string; payload: string; attempts: number }[] {
    return this.db.prepare(`SELECT id, payload, attempts FROM inbox
      WHERE status = 'pending' AND next_at <= ? ORDER BY created_at LIMIT 50`).all(this.now()) as any[];
  }

  inboxDone(id: string) {
    this.db.prepare(`UPDATE inbox SET status = 'done' WHERE id = ?`).run(id);
  }

  inboxFailed(id: string, error: string, nextAt: number | null) {
    this.db.prepare(`UPDATE inbox SET status = ?, attempts = attempts + 1, next_at = COALESCE(?, next_at), last_error = ? WHERE id = ?`)
      .run(nextAt === null ? 'dead' : 'pending', nextAt, error, id);
  }

  /** 测试用：让重试不用等退避时间。 */
  forceInboxDue() {
    this.db.prepare(`UPDATE inbox SET next_at = 0 WHERE status = 'pending'`).run();
  }

  inboxCounts(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM inbox GROUP BY status').all() as any[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  // ---------- 货源对应关系和采购任务 ----------

  saveSkuMapping(m: SkuMapping) {
    this.db.prepare(`INSERT OR REPLACE INTO sku_map
      (seller_sku, shop_id, draft_id, source_url, spec_text, purchase_cny, fixed_cost_jpy, commission_rate, product_id, sku_id, warehouse_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(m.sellerSku, m.shopId, m.draftId, m.sourceUrl, m.specText, m.purchaseCny, m.fixedCostJpy, m.commissionRate, m.productId, m.skuId, m.warehouseId);
  }

  skuMapping(shopId: string, sellerSku: string): SkuMapping | null {
    const r = this.db.prepare('SELECT * FROM sku_map WHERE shop_id = ? AND seller_sku = ?').get(shopId, sellerSku) as any;
    if (!r) return null;
    return {
      sellerSku: r.seller_sku, shopId: r.shop_id, draftId: r.draft_id, sourceUrl: r.source_url, specText: r.spec_text,
      purchaseCny: r.purchase_cny, fixedCostJpy: r.fixed_cost_jpy, commissionRate: r.commission_rate,
      productId: r.product_id, skuId: r.sku_id, warehouseId: r.warehouse_id,
    };
  }

  /** 同一订单同一 SKU 只生成一个任务。已存在时返回 null。 */
  insertPurchaseTask(t: {
    shopId: string; orderId: string; lineKey: string; sellerSku: string; quantity: number; saleJpy: number;
    deadline: number | null; productId: string | null; skuId: string | null; warehouseId: string | null;
  }): PurchaseTask | null {
    const id = randomUUID();
    const r = this.db.prepare(`INSERT OR IGNORE INTO purchase_tasks
      (id, shop_id, order_id, line_key, seller_sku, quantity, sale_jpy, deadline, status, created_at, product_id, sku_id, warehouse_id)
      VALUES (?,?,?,?,?,?,?,?,'awaiting_purchase',?,?,?,?)`)
      .run(id, t.shopId, t.orderId, t.lineKey, t.sellerSku, t.quantity, t.saleJpy, t.deadline, this.now(), t.productId, t.skuId, t.warehouseId);
    return Number(r.changes) === 1 ? this.purchaseTask(id) : null;
  }

  purchaseTask(id: string): PurchaseTask | null {
    const r = this.db.prepare('SELECT * FROM purchase_tasks WHERE id = ?').get(id);
    return r ? toTask(r) : null;
  }

  tasksForOrder(orderId: string): PurchaseTask[] {
    return this.db.prepare('SELECT * FROM purchase_tasks WHERE order_id = ?').all(orderId).map(toTask);
  }

  setTaskMessage(id: string, messageId: string) {
    this.db.prepare('UPDATE purchase_tasks SET message_id = ? WHERE id = ?').run(messageId, id);
  }

  /** 状态转换是原子的，重复点击或重复推送只有第一次成功。 */
  transitionTask(id: string, status: PurchaseTask['status'], from: PurchaseTask['status'] = 'awaiting_purchase'): boolean {
    const r = this.db.prepare('UPDATE purchase_tasks SET status = ? WHERE id = ? AND status = ?').run(status, id, from);
    return Number(r.changes) === 1;
  }

  purchaseTaskForLine(orderId: string, lineKey: string): PurchaseTask | null {
    const r = this.db.prepare('SELECT * FROM purchase_tasks WHERE order_id = ? AND line_key = ?').get(orderId, lineKey);
    return r ? toTask(r) : null;
  }

  setTaskCost(id: string, purchaseCny: number) {
    this.db.prepare('UPDATE purchase_tasks SET purchase_cny = ? WHERE id = ?').run(purchaseCny, id);
  }

  tasksDueForReminder(beforeUnix: number): PurchaseTask[] {
    return this.db.prepare(`SELECT * FROM purchase_tasks
      WHERE status = 'awaiting_purchase' AND reminded = 0 AND deadline IS NOT NULL AND deadline <= ?`)
      .all(beforeUnix).map(toTask);
  }

  markReminded(id: string) {
    this.db.prepare('UPDATE purchase_tasks SET reminded = 1 WHERE id = ?').run(id);
  }

  countTasks(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM purchase_tasks GROUP BY status').all() as any[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }
}
