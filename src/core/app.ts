// HTTP 入口和业务编排。不依赖具体的 http 框架，测试时可以直接调用 handle()。
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ApprovalGate } from './approval.ts';
import type { Store } from './db.ts';
import { draftCard, manualCard, statusCard } from './feishu/cards.ts';
import type { FeishuClient } from './feishu/client.ts';
import { decryptEvent, verifySignature } from './feishu/crypto.ts';
import type { Claude } from './llm/claude.ts';
import { downloadImage } from './listing/images.ts';
import { structureCapture, structureScreenshot, type RawCapture } from './listing/llm.ts';
import { buildManualDraft, copyText, writeListingFiles, writePackage } from './listing/manual.ts';
import { buildDraft, ListingBlocked, type PipelineDeps } from './listing/pipeline.ts';
import { deactivateExecutor, publishExecutor, saveMappings } from './listing/publish.ts';
import { handleCancellationRequest, handleOrderStatus, refreshCostCard, type OrderDeps } from './orders/flow.ts';
import { overridePrice, type PricingConfig } from './pricing/engine.ts';
import type { FxProvider } from './pricing/fx.ts';
import type { TikTokClient } from './tiktok/client.ts';
import { verifyWebhook } from './tiktok/sign.ts';
import type { Account, ListingDraft, SourceProduct } from './types.ts';
import { mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { generateCaption, videoAskCard, videoReadyCard } from './video.ts';
import type { VideoRow } from './db.ts';

export interface HttpRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  rawBody: string;
}

export interface HttpResponse {
  status: number;
  body: string;
  contentType?: string;
}

export interface AppConfig {
  ttsAppKey: string;
  ttsAppSecret: string;
  ttsServiceId: string;
  feishuVerificationToken: string;
  feishuEncryptKey: string;
  adminOpenIds: string[];
  opsChatId: string;
  captureToken: string;
  /** 半自动模式的资料包放在这里。 */
  packageDir: string;
  /** 视频文件存放位置。 */
  videoDir?: string;
  /** 账号矩阵。为空时视为只有一个默认账号。 */
  accounts?: Account[];
  defaultAccountId?: string;
  /** 桌面端操作者的身份，自动拥有批准权限。 */
  localOperator?: string;
}

export const LOCAL_OPERATOR = 'local:desktop';

export interface CaptureBody {
  jobId?: string;
  status: 'ok' | 'blocked' | 'error';
  message?: string;
  capture?: RawCapture;
}

export interface AppDeps {
  config: AppConfig;
  store: Store;
  tiktok: TikTokClient;
  feishu: FeishuClient;
  claude: Claude;
  fx: FxProvider;
  pricing: PricingConfig;
  pipeline: PipelineDeps;
  now?: () => number;
}

const json = (status: number, data: unknown): HttpResponse => ({
  status,
  body: JSON.stringify(data),
  contentType: 'application/json',
});

const URL_RE = /https?:\/\/[^\s<>"'，。；）)]+/i;

/** 插件有权限打开的货源站。其他网站请用户发截图。 */
const CAPTURE_HOSTS = [/(^|\.)1688\.com$/i, /(^|\.)taobao\.com$/i, /(^|\.)tmall\.com$/i, /(^|\.)pinduoduo\.com$/i, /(^|\.)yangkeduo\.com$/i];

export function isCapturable(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && CAPTURE_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

export function platformOf(url: string): string {
  try {
    const host = new URL(url).hostname;
    if (/1688\.com$/.test(host)) return '1688';
    if (/taobao\.com$|tmall\.com$/.test(host)) return 'taobao';
    if (/pinduoduo\.com$|yangkeduo\.com$/.test(host)) return 'pinduoduo';
    return host;
  } catch {
    return 'unknown';
  }
}

const MAX_INBOX_ATTEMPTS = 10;

export const HELP_TEXT = [
  '可用指令：',
  '· 发货源链接：取数、翻译、定价，生成上架卡片',
  '· 发商品截图：Claude 读图后走同样流程',
  '· 货源 + SKU 编码或关键词：查货源链接和成本',
  '· 发视频：选择挂车或曝光，自动生成日文文案和话题',
  '· 链接前写账号名（如“账号A https://…”）可以指定上架到哪个账号',
  '· 授权：生成 TikTok 店铺授权链接',
  '· 状态：查看草稿、视频和采购任务数量',
  '还没有接 TikTok 接口时走半自动模式：系统准备文案、图片和售价，你手动发布到卖家中心。',
].join('\n');

export class App {
  private d: AppDeps;
  readonly gate: ApprovalGate;
  private orderDeps: OrderDeps;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: AppDeps) {
    this.d = deps;
    const admins = [...deps.config.adminOpenIds];
    if (deps.config.localOperator) admins.push(deps.config.localOperator);
    this.gate = new ApprovalGate(deps.store, admins, {
      publish_listing: publishExecutor({ store: deps.store, tiktok: deps.tiktok, fx: deps.fx, pricing: deps.pricing }),
      deactivate_product: deactivateExecutor({ store: deps.store, tiktok: deps.tiktok }),
    });
    this.orderDeps = {
      store: deps.store,
      tiktok: deps.tiktok,
      feishu: deps.feishu,
      fx: deps.fx,
      pricing: deps.pricing,
      opsChatId: deps.config.opsChatId,
      now: deps.now,
    };
  }

  get orders(): OrderDeps { return this.orderDeps; }

  /** 串行执行，出错时记日志，不影响后面的任务。 */
  private enqueue(label: string, fn: () => Promise<void>) {
    this.queue = this.queue.then(fn).catch((err) => {
      console.error(`[${label}]`, err);
      this.d.store.audit('task.error', null, { label, error: String(err?.message ?? err) });
    });
  }

  idle(): Promise<unknown> { return this.queue; }

  async handle(req: HttpRequest): Promise<HttpResponse> {
    const route = `${req.method} ${req.path}`;
    switch (route) {
      case 'GET /healthz': return json(200, { ok: true });
      case 'POST /feishu/events': return this.feishuEntry(req);
      case 'POST /tts/webhook': return this.tiktokWebhook(req);
      case 'GET /tts/oauth/callback': return this.oauthCallback(req);
      case 'GET /capture/next': return this.captureNext(req);
      case 'POST /capture/result': return this.captureResult(req);
      default: return json(404, { error: 'not found' });
    }
  }

  // ---------- 飞书 ----------

  private async feishuEntry(req: HttpRequest): Promise<HttpResponse> {
    const { feishuEncryptKey, feishuVerificationToken } = this.d.config;
    let payload: any;
    try {
      payload = JSON.parse(req.rawBody);
      if (payload.encrypt) {
        if (!feishuEncryptKey) return json(400, { error: 'encrypt key not configured' });
        payload = JSON.parse(decryptEvent(payload.encrypt, feishuEncryptKey));
      }
    } catch {
      return json(400, { error: 'bad body' });
    }

    if (payload.type === 'url_verification') {
      if (payload.token !== feishuVerificationToken) return json(403, { error: 'bad token' });
      return json(200, { challenge: payload.challenge });
    }

    if (feishuEncryptKey) {
      const ok = verifySignature({
        timestamp: req.headers['x-lark-request-timestamp'] ?? '',
        nonce: req.headers['x-lark-request-nonce'] ?? '',
        encryptKey: feishuEncryptKey,
        rawBody: req.rawBody,
        signature: req.headers['x-lark-signature'] ?? '',
      });
      if (!ok) return json(401, { error: 'bad signature' });
    }
    if (payload.header?.token !== feishuVerificationToken) return json(403, { error: 'bad token' });

    const eventType = payload.header?.event_type;
    if (eventType === 'card.action.trigger') return json(200, await this.feishuCardAction(payload.event));
    if (eventType === 'im.message.receive_v1') this.feishuMessage(payload.event, payload.header?.event_id);
    return json(200, {});
  }

  /** 飞书消息入口。HTTP 回调和长连接共用。 */
  feishuMessage(event: any, eventId?: string) {
    // 飞书文档要求用 message_id 去重，event_id 不可靠。
    const dedupeKey = event?.message?.message_id ?? eventId ?? '';
    if (!dedupeKey || !this.d.store.markSeen(dedupeKey)) return;
    this.enqueue('feishu.message', () => this.onMessage(event));
  }

  /** 飞书卡片按钮入口。必须 3 秒内返回。 */
  feishuCardAction(event: any): Promise<any> {
    return this.onCardAction(event);
  }

  // ---------- 账号矩阵 ----------

  accounts(): Account[] {
    const list = this.d.config.accounts ?? [];
    return list.length > 0 ? list : [{ id: 'default', name: '默认账号', type: 'shop' }];
  }

  private account(id?: string | null): Account {
    const list = this.accounts();
    return list.find((a) => a.id === id) ?? list.find((a) => a.id === this.d.config.defaultAccountId) ?? list[0];
  }

  /** 文字里出现了哪个账号名就用哪个账号，没有就用默认账号。 */
  private accountFromText(text: string): Account {
    const hit = this.accounts()
      .filter((a) => a.name && text.includes(a.name))
      .sort((a, b) => b.name.length - a.name.length)[0];
    return hit ?? this.account(null);
  }

  private async onMessage(event: any) {
    const { sender, message } = event;
    const chatId: string = message.chat_id;
    const openId: string = sender?.sender_id?.open_id ?? '';

    if (!this.gate.isAdmin(openId)) {
      await this.d.feishu.sendText(chatId, `你还没有操作权限。把下面两行填进配置文件后重启服务：\nFEISHU_ADMIN_OPEN_IDS=${openId}\nFEISHU_OPS_CHAT_ID=${chatId}`);
      return;
    }

    const content = JSON.parse(message.content ?? '{}');
    if (message.message_type === 'image') {
      await this.fromScreenshot(chatId, message.message_id, content.image_key);
      return;
    }
    if (message.message_type === 'media' || (message.message_type === 'file' && /\.(mp4|mov|m4v|webm)$/i.test(content.file_name ?? ''))) {
      await this.fromFeishuVideo(chatId, message.message_id, content);
      return;
    }
    if (message.message_type !== 'text') {
      await this.d.feishu.sendText(chatId, '支持：货源链接、商品截图、视频。其他类型暂不处理。');
      return;
    }

    // 群聊里 @机器人 时，文字开头带 @_user_1 这样的占位符。
    const text: string = (content.text ?? '').replace(/@_user_\d+/g, '').trim();
    const url = text.match(URL_RE)?.[0];
    if (url) return this.onLink(chatId, url, this.accountFromText(text.replace(url, '')).id);
    if (/^(授权|绑定店铺)$/.test(text)) return this.sendAuthLink(chatId);
    if (/^(id|我的id)$/i.test(text)) {
      await this.d.feishu.sendText(chatId, `FEISHU_ADMIN_OPEN_IDS=${openId}\nFEISHU_OPS_CHAT_ID=${chatId}`);
      return;
    }
    if (/^(状态|status)$/i.test(text)) return this.sendStatus(chatId);
    const lookup = /^(?:货源|查货源|订单)\s+(.+)$/.exec(text)?.[1] ?? /^[0-9a-f]{8}-\d+$/i.exec(text)?.[0];
    if (lookup) return this.sendSourceLookup(chatId, lookup.trim());
    await this.d.feishu.sendText(chatId, HELP_TEXT);
  }

  private async onLink(chatId: string, url: string, accountId?: string) {
    if (!isCapturable(url)) {
      await this.d.feishu.sendText(chatId, '这个网站暂时打不开。请发商品页截图，我用截图继续。');
      return;
    }
    const account = this.account(accountId);
    this.d.store.enqueueCapture(url, chatId, account.id);
    await this.d.feishu.sendText(chatId, `收到链接，账号「${account.name}」。电脑上的 Seller Agent 正在打开页面取数。`);
  }

  /** 桌面端“粘贴链接上架”。结果同时出现在桌面端和飞书运营群。 */
  submitLink(url: string, accountId?: string): { ok: boolean; message: string } {
    if (!isCapturable(url)) return { ok: false, message: '只支持 1688、淘宝、天猫、拼多多的 https 商品链接。其他网站请在飞书发截图。' };
    const account = this.account(accountId);
    this.d.store.enqueueCapture(url, this.d.config.opsChatId, account.id);
    this.d.store.audit('desktop.link', LOCAL_OPERATOR, { url, accountId: account.id });
    return { ok: true, message: `已加入取数队列（账号：${account.name}）` };
  }

  private async fromScreenshot(chatId: string, messageId: string, imageKey: string) {
    await this.d.feishu.sendText(chatId, '收到截图，正在读取。');
    await this.runPipeline(chatId, async () => {
      const { bytes, mediaType } = await this.d.feishu.downloadResource(messageId, imageKey, 'image');
      return structureScreenshot(
        this.d.claude,
        { mediaType, base64: Buffer.from(bytes).toString('base64') },
        `feishu-screenshot:${messageId}`,
      );
    });
  }

  private async sendAuthLink(chatId: string) {
    if (!this.d.config.ttsServiceId) {
      await this.d.feishu.sendText(chatId, '还没有配置 TikTok 接口，现在是半自动模式。发货源链接就能生成发布资料。');
      return;
    }
    const state = randomBytes(16).toString('hex');
    this.d.store.addOauthState(state);
    const url = `https://services.tiktokshop.com/open/authorize?service_id=${encodeURIComponent(this.d.config.ttsServiceId)}&state=${state}`;
    await this.d.feishu.sendText(chatId, `用店铺主账号打开这个链接完成授权，1 小时内有效：\n${url}`);
  }

  /** 半自动模式没有订单推送，出单后用 SKU 编码或关键词查货源。 */
  private async sendSourceLookup(chatId: string, query: string) {
    const { store } = this.d;
    const shops = ['manual', ...store.shops().map((s) => s.id)];
    for (const shopId of shops) {
      const m = store.skuMapping(shopId, query);
      if (m) {
        const draft = store.draft(m.draftId);
        await this.d.feishu.sendText(chatId, [
          draft?.source.title ?? '',
          `规格：${m.specText}`,
          `货源成本：${m.purchaseCny} 元 / 件`,
          `货源链接：${m.sourceUrl}`,
        ].filter(Boolean).join('\n'));
        return;
      }
    }
    const found = store.searchDrafts(query);
    if (found.length === 0) {
      await this.d.feishu.sendText(chatId, `没有找到“${query}”的货源记录。`);
      return;
    }
    await this.d.feishu.sendText(chatId, found.map((d) => [
      d.source.title,
      `SKU 编码：${d.skus.map((s) => s.sellerSku).join('、')}`,
      `货源链接：${d.source.url}`,
    ].join('\n')).join('\n\n'));
  }

  private async sendStatus(chatId: string) {
    const { store } = this.d;
    const shops = store.shops().map((s) => `${s.name}（${s.region}）`).join('、') || '未授权（半自动模式）';
    await this.d.feishu.sendText(chatId, [
      `店铺：${shops}`,
      `草稿：${JSON.stringify(store.countDrafts())}`,
      `采购任务：${JSON.stringify(store.countTasks())}`,
    ].join('\n'));
  }

  /** 任何一步出错都要告诉用户，不让链接悄悄消失。 */
  private async runPipeline(chatId: string, load: () => Promise<SourceProduct>, accountId?: string | null) {
    try {
      const source = await load();
      const shop = this.d.store.shops()[0];
      if (!shop) {
        await this.runManual(chatId, source, this.account(accountId).id);
        return;
      }
      const draft = await buildDraft(this.d.pipeline, shop, source);
      draft.accountId = this.account(accountId).id;
      await this.attachPreviews(draft);
      this.d.store.saveDraft(draft);
      const action = this.gate.propose('publish_listing', shop.id, { draftId: draft.id }, `listing:${draft.id}`);
      const messageId = await this.d.feishu.sendCard(chatId, draftCard(draft, action.id));
      this.d.store.setDraftMessage(draft.id, chatId, messageId);
    } catch (err) {
      const message = err instanceof ListingBlocked ? `不建议上架：${err.message}` : `上架流程出错：${(err as Error).message}`;
      await this.d.feishu.sendText(chatId, message);
      if (!(err instanceof ListingBlocked)) throw err;
    }
  }

  /** 半自动模式：准备资料，由你手动发布。 */
  private async runManual(chatId: string, source: SourceProduct, accountId: string) {
    const { draft, images } = await buildManualDraft(this.d.pipeline, source);
    draft.accountId = accountId;
    draft.packageDir = writePackage(this.d.config.packageDir, draft, images);
    for (const image of images) {
      try {
        draft.previewImageKeys.push(await this.d.feishu.uploadImage(image.bytes, 'image.jpg'));
      } catch (err) {
        draft.notes.push(`飞书预览图上传失败：${(err as Error).message}`);
      }
    }
    this.d.store.saveDraft(draft, 'awaiting_manual');
    await this.d.feishu.sendText(chatId, copyText(draft));
    const messageId = await this.d.feishu.sendCard(chatId, manualCard(draft));
    this.d.store.setDraftMessage(draft.id, chatId, messageId);
  }

  /** 预览图传到飞书。失败不影响流程，卡片只是少几张图。 */
  private async attachPreviews(draft: ListingDraft) {
    // 翻译过的图排在前面，方便检查版式有没有错位。
    const previews = [...draft.images].sort((a, b) => Number(b.translated) - Number(a.translated)).slice(0, 3);
    for (const image of previews) {
      try {
        const bytes = await downloadImage(this.d.pipeline.fetchImpl, image.previewUrl, { translatorResult: image.translated });
        draft.previewImageKeys.push(await this.d.feishu.uploadImage(bytes, 'preview.jpg'));
      } catch (err) {
        draft.notes.push(`预览图失败：${(err as Error).message}`);
      }
    }
  }

  private async onCardAction(event: any): Promise<any> {
    const value = event.action?.value ?? {};
    const operator: string = event.operator?.open_id ?? '';
    const toast = (type: string, content: string) => ({ toast: { type, content } });
    try {
      switch (value.act) {
        case 'approve': return await this.onApprove(value, operator, event.action?.form_value ?? {}, toast);
        case 'reject': {
          const r = this.gate.reject(value.actionId, operator);
          if (!r.ok) return toast('error', r.message);
          this.d.store.setDraftStatus(value.draftId, 'rejected');
          return { ...toast('info', r.message), card: { type: 'raw', data: statusCard('已放弃', 'grey', ['这个商品不再提交。']) } };
        }
        case 'manual_reprice': return this.onManualReprice(value.draftId, operator, event.action?.form_value ?? {}, toast);
        case 'manual_done': return this.onManualDone(value.draftId, operator, toast);
        case 'manual_reject': {
          if (!this.gate.isAdmin(operator)) return toast('error', '你没有操作权限');
          if (!this.d.store.transitionDraft(value.draftId, 'awaiting_manual', 'rejected')) return toast('warning', '这个商品已经处理过');
          return { ...toast('info', '已放弃'), card: { type: 'raw', data: statusCard('已放弃', 'grey', ['这个商品不再处理。']) } };
        }
        case 'purchased': return this.onPurchased(value.taskId, operator, toast);
        case 'out_of_stock': return this.onOutOfStock(value.taskId, operator, toast);
        case 'cost_changed': return await this.onCostChanged(value.taskId, operator, event.action?.form_value ?? {}, toast);
        case 'video_kind': {
          if (!this.gate.isAdmin(operator)) return toast('error', '你没有操作权限');
          const form = event.action?.form_value ?? {};
          const r = this.setVideoInfo(value.videoId, value.kind, String(form.product ?? ''), String(form.hint ?? ''), operator);
          if (!r.ok) return toast('warning', r.message);
          return { ...toast('info', '正在生成文案'), card: { type: 'raw', data: statusCard('正在生成文案', 'blue', ['Claude 正在写日文文案和话题，稍等几秒。']) } };
        }
        case 'video_done': {
          if (!this.gate.isAdmin(operator)) return toast('error', '你没有操作权限');
          const r = this.markVideoPublished(value.videoId, operator);
          if (!r.ok) return toast('warning', r.message);
          return { ...toast('success', '已记录'), card: { type: 'raw', data: statusCard('视频已发布', 'green', ['已记录发布时间。']) } };
        }
        case 'video_reject': {
          if (!this.gate.isAdmin(operator)) return toast('error', '你没有操作权限');
          if (!this.d.store.transitionVideo(value.videoId, ['awaiting_info', 'ready', 'failed'], 'rejected')) return toast('warning', '这个视频已经处理过');
          return { ...toast('info', '已放弃'), card: { type: 'raw', data: statusCard('已放弃', 'grey', ['这个视频不再处理。']) } };
        }
        default: return toast('warning', '未知操作');
      }
    } catch (err) {
      return toast('error', (err as Error).message);
    }
  }

  private async onApprove(value: any, operator: string, form: any, toast: (t: string, c: string) => any) {
    if (!this.gate.isAdmin(operator)) return toast('error', '你没有批准权限');
    const draft = this.d.store.draft(value.draftId);
    if (!draft) return toast('error', '草稿不存在');
    const action = this.d.store.action(value.actionId);
    if (!action) return toast('error', '找不到这个动作');
    if (action.status !== 'pending') return toast('warning', `这个动作已经处理过（${action.status}）`);

    const raw = String(form.price ?? '').replace(/[,，¥\s]/g, '');
    if (raw) {
      const price = Number(raw);
      if (!Number.isFinite(price) || price <= 0) return toast('error', '价格格式不对');
      const { _status, _messageId, _chatId, ...plain } = draft;
      const pricing = overridePrice(plain.pricing, price, this.d.pricing);
      const updated: ListingDraft = {
        ...plain,
        pricing,
        skus: plain.skus.map((s) => ({ ...s, priceJpy: pricing.skus.find((p) => p.sourceSkuId === s.sourceSkuId)!.priceJpy })),
      };
      this.d.store.saveDraft(updated, _status);
      this.d.store.audit('price.override', operator, { draftId: draft.id, price });
    }

    // force 只在定价“建议放弃”时由卡片带上。它和批准一起写进审计日志。
    const claim = this.gate.approve(value.actionId, operator, { force: Boolean(value.force) });
    if (!claim.ok) return toast('warning', claim.message);

    this.enqueue('listing.publish', async () => {
      const r = await claim.run();
      const messageId = this.d.store.draft(value.draftId)?._messageId;
      const finalCard = r.ok
        ? statusCard('已提交审核', 'green', [`商品 ID：${(r.result as any).productId}`, 'TikTok 审核结果会推送到这里。'])
        : statusCard('提交失败', 'red', [r.error]);
      if (messageId) await this.d.feishu.updateCard(messageId, finalCard);
    });
    return { ...toast('info', '已批准，正在提交'), card: { type: 'raw', data: statusCard('提交中', 'blue', ['正在提交到 TikTok。']) } };
  }

  private onManualReprice(draftId: string, operator: string, form: any, toast: (t: string, c: string) => any) {
    if (!this.gate.isAdmin(operator)) return toast('error', '你没有操作权限');
    const stored = this.d.store.draft(draftId);
    if (!stored || stored._status !== 'awaiting_manual') return toast('warning', '这个商品已经处理过');
    const price = Number(String(form.price ?? '').replace(/[,，¥\s]/g, ''));
    if (!Number.isFinite(price) || price <= 0) return toast('error', '请填写日元售价');

    const { _status, _messageId, _chatId, ...plain } = stored;
    const pricing = overridePrice(plain.pricing, price, this.d.pricing);
    const updated: ListingDraft = {
      ...plain,
      pricing,
      skus: plain.skus.map((s) => ({ ...s, priceJpy: pricing.skus.find((p) => p.sourceSkuId === s.sourceSkuId)!.priceJpy })),
    };
    this.d.store.saveDraft(updated, _status);
    if (updated.packageDir) writeListingFiles(updated.packageDir, updated);
    this.d.store.audit('price.override', operator, { draftId, price });
    return { ...toast('info', '售价已更新'), card: { type: 'raw', data: manualCard(updated) } };
  }

  private onManualDone(draftId: string, operator: string, toast: (t: string, c: string) => any) {
    if (!this.gate.isAdmin(operator)) return toast('error', '你没有操作权限');
    const draft = this.d.store.draft(draftId);
    if (!draft) return toast('error', '草稿不存在');
    if (!this.d.store.transitionDraft(draftId, 'awaiting_manual', 'manual_published')) return toast('warning', '这个商品已经处理过');
    saveMappings(this.d.store, draft, { id: 'manual' }, null, new Map());
    this.d.store.audit('manual.published', operator, { draftId });
    return {
      ...toast('success', '已记录'),
      card: { type: 'raw', data: statusCard('已记录发布', 'green', [
        `SKU 编码：${draft.skus.map((s) => s.sellerSku).join('、')}`,
        '出单后把 SKU 编码发给机器人，就能查到货源链接。',
      ]) },
    };
  }

  private onPurchased(taskId: string, operator: string, toast: (t: string, c: string) => any) {
    if (!this.gate.isAdmin(operator)) return toast('error', '你没有操作权限');
    if (!this.d.store.transitionTask(taskId, 'purchased')) return toast('warning', '这个任务已经处理过');
    this.d.store.audit('purchase.done', operator, { taskId });
    return { ...toast('success', '已记录'), card: { type: 'raw', data: statusCard('已下单', 'green', ['记得在发货期限内交给物流。']) } };
  }

  private onOutOfStock(taskId: string, operator: string, toast: (t: string, c: string) => any) {
    if (!this.gate.isAdmin(operator)) return toast('error', '你没有操作权限');
    const task = this.d.store.purchaseTask(taskId);
    if (!task) return toast('error', '任务不存在');
    if (!this.d.store.transitionTask(taskId, 'out_of_stock')) return toast('warning', '这个任务已经处理过');

    if (task.productId) {
      const action = this.gate.propose('deactivate_product', task.shopId, { productId: task.productId }, `deactivate:${task.id}`);
      const claim = this.gate.approve(action.id, operator); // 点“无货”本身就是人工确认
      if (claim.ok) {
        this.enqueue('product.deactivate', async () => {
          const r = await claim.run();
          if (!r.ok) await this.d.feishu.sendText(this.d.config.opsChatId, `商品 ${task.productId} 下架失败：${r.error}`);
        });
      }
    }
    return {
      ...toast('warning', '已记录无货，正在下架这个商品'),
      card: { type: 'raw', data: statusCard('货源无货', 'red', [
        `订单 ${task.orderId} 需要你处理：换货源或联系买家取消。`,
        '商品正在下架，所有规格都会隐藏。补货后到后台重新上架。',
      ]) },
    };
  }

  private async onCostChanged(taskId: string, operator: string, form: any, toast: (t: string, c: string) => any) {
    if (!this.gate.isAdmin(operator)) return toast('error', '你没有操作权限');
    const cost = Number(String(form.new_cost ?? '').trim());
    if (!Number.isFinite(cost) || cost <= 0) return toast('error', '请填写新的人民币单价');
    const card = await refreshCostCard(this.orderDeps, taskId, cost);
    return { ...toast('info', '利润已重算'), card: { type: 'raw', data: card } };
  }

  // ---------- TikTok ----------

  private async tiktokWebhook(req: HttpRequest): Promise<HttpResponse> {
    const { ttsAppKey, ttsAppSecret } = this.d.config;
    if (!ttsAppSecret) return json(503, { error: 'tiktok not configured' });
    const signature = req.headers['authorization'] ?? '';
    if (!verifyWebhook(ttsAppKey, ttsAppSecret, req.rawBody, signature)) return json(401, { error: 'bad signature' });

    const payload = JSON.parse(req.rawBody);
    const eventId = payload.tts_notification_id ?? `${payload.type}:${payload.timestamp}:${payload.shop_id}:${req.rawBody.length}`;
    // 先落库再回 200。处理放在收件箱里，失败会重试，服务重启也不会丢。
    this.d.store.addToInbox(`tts:${eventId}`, req.rawBody);
    this.enqueue('inbox', () => this.processInbox());
    return json(200, {});
  }

  private async onWebhook(payload: any) {
    const data = payload.data ?? {};
    const ops = this.d.config.opsChatId;
    if (payload.type === 1) {
      await handleOrderStatus(this.orderDeps, payload.shop_id, data.order_id, data.order_status);
    } else if (payload.type === 11) {
      await handleCancellationRequest(this.orderDeps, data.order_id, data.cancel_status);
    } else if (payload.type === 5) {
      const id = data.product_id;
      const reason = data.suspended_reason ?? '原因未提供';
      if (data.status === 'PRODUCT_AUDIT_FAILURE') await this.d.feishu.sendText(ops, `商品 ${id} 审核未通过：${reason}`);
      else if (data.status === 'PRODUCT_FIRST_PASS_REVIEW') await this.d.feishu.sendText(ops, `商品 ${id} 审核通过。`);
      else if (data.status === 'PRODUCT_STATUS_CHANGED') {
        await this.d.feishu.sendText(ops, `商品 ${id} 状态有变化${data.suspended_reason ? `：${data.suspended_reason}` : '，请到后台查看'}。`);
      }
    }
  }

  /** 处理到期的 Webhook。第 3 次失败时告警，第 10 次放弃并再次告警。 */
  async processInbox() {
    const now = (this.d.now ?? Date.now)();
    for (const item of this.d.store.dueInbox()) {
      try {
        await this.onWebhook(JSON.parse(item.payload));
        this.d.store.inboxDone(item.id);
      } catch (err) {
        const error = String((err as Error).message ?? err);
        const attempts = item.attempts + 1;
        const giveUp = attempts >= MAX_INBOX_ATTEMPTS;
        this.d.store.inboxFailed(item.id, error, giveUp ? null : now + Math.min(30, 2 ** attempts) * 60_000);
        this.d.store.audit('inbox.failed', null, { id: item.id, attempts, error });
        if (attempts === 3 || giveUp) {
          await this.alert(`TikTok 推送处理失败（第 ${attempts} 次${giveUp ? '，已停止重试' : '，还会继续重试'}）：${error}\n内容：${item.payload.slice(0, 300)}`);
        }
      }
    }
  }

  /** 告警本身失败时只记日志，不能让它打断主流程。 */
  private async alert(text: string) {
    if (!this.d.config.opsChatId) {
      console.error('[alert]', text);
      return;
    }
    try {
      await this.d.feishu.sendText(this.d.config.opsChatId, text);
    } catch (err) {
      console.error('[alert]', text, err);
    }
  }

  /** 服务启动时调用：上次还在执行的动作结果不确定，标记失败并告诉人。 */
  async recover() {
    for (const action of this.d.store.runningActions()) {
      this.d.store.finishAction(action.id, 'failed', { error: '服务重启，结果不确定' });
      this.d.store.audit('action.interrupted', null, { id: action.id, type: action.type });
      await this.alert(`服务重启时有动作没有执行完（${action.type}，${JSON.stringify(action.payload)}）。请到店铺后台确认结果，不要直接重复操作。`);
    }
  }

  private async oauthCallback(req: HttpRequest): Promise<HttpResponse> {
    const code = req.query.get('code');
    const state = req.query.get('state') ?? '';
    const page = (status: number, text: string): HttpResponse => ({ status, body: text, contentType: 'text/plain; charset=utf-8' });
    if (!code) return page(400, '缺少授权码');
    if (!this.d.store.consumeOauthState(state)) return page(403, '授权链接已失效，请在飞书重新发“授权”');

    const tokens = await this.d.tiktok.exchangeCode(code);
    const shops = await this.d.tiktok.authorizedShops(tokens.accessToken);
    for (const s of shops) {
      this.d.store.saveShop({
        id: s.id, cipher: s.cipher, name: s.name, region: s.region,
        accessToken: tokens.accessToken, accessTokenExpireAt: tokens.accessTokenExpireAt,
        refreshToken: tokens.refreshToken, refreshTokenExpireAt: tokens.refreshTokenExpireAt,
      });
    }
    this.enqueue('oauth.notify', async () => {
      await this.d.feishu.sendText(this.d.config.opsChatId, `店铺授权成功：${shops.map((s) => s.name).join('、')}`);
    });
    return page(200, '授权成功，可以关闭这个页面。');
  }

  /** 插件 15 分钟没有回结果就告诉用户，不让链接悄悄卡住。由 server.ts 定时调用。 */
  async expireCaptures() {
    const before = (this.d.now ?? Date.now)() - 15 * 60_000;
    for (const job of this.d.store.staleCaptures(before)) {
      await this.d.feishu.sendText(job.chatId, `取数超时：${job.url}\n电脑可能没开，或插件没有运行。请打开后重新发送链接。`);
    }
  }

  /** 令牌到期前 24 小时刷新。由 server.ts 定时调用。 */
  async refreshTokens() {
    const nowSec = Math.floor((this.d.now ?? Date.now)() / 1000);
    for (const shop of this.d.store.shops()) {
      if (shop.accessTokenExpireAt - nowSec > 24 * 3600) continue;
      try {
        const t = await this.d.tiktok.refreshToken(shop.refreshToken);
        this.d.store.saveShop({
          ...shop,
          accessToken: t.accessToken, accessTokenExpireAt: t.accessTokenExpireAt,
          refreshToken: t.refreshToken, refreshTokenExpireAt: t.refreshTokenExpireAt,
        });
      } catch (err) {
        await this.alert(`店铺 ${shop.name} 的 TikTok 令牌刷新失败：${(err as Error).message}。令牌过期后订单和上架都会中断，请尽快处理。`);
      }
    }
  }

  // ---------- 取数插件 ----------

  private captureAuthorized(req: HttpRequest): boolean {
    const expected = Buffer.from(`Bearer ${this.d.config.captureToken}`);
    const actual = Buffer.from(req.headers['authorization'] ?? '');
    return Boolean(this.d.config.captureToken) && expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private async captureNext(req: HttpRequest): Promise<HttpResponse> {
    if (!this.captureAuthorized(req)) return json(401, { error: 'unauthorized' });
    return json(200, { job: this.d.store.nextCapture() });
  }

  private async captureResult(req: HttpRequest): Promise<HttpResponse> {
    if (!this.captureAuthorized(req)) return json(401, { error: 'unauthorized' });
    let body: CaptureBody;
    try {
      body = JSON.parse(req.rawBody);
    } catch {
      return json(400, { error: 'bad body' });
    }
    const r = this.completeCapture(body);
    return r.ok ? json(200, { ok: true }) : json(404, { error: r.error });
  }

  /** 取数结果入口。桌面端内置浏览器和旧版插件共用。 */
  completeCapture(body: CaptureBody, accountId?: string): { ok: true } | { ok: false; error: string } {
    // 用户在货源页手动发送时没有 jobId，通知发到运营群。
    const job = body.jobId ? this.d.store.finishCapture(body.jobId, body.status) : null;
    if (body.jobId && !job) return { ok: false, error: 'unknown job' };
    const chatId = job?.chatId ?? this.d.config.opsChatId;
    const account = job?.accountId ?? accountId ?? null;

    if (body.status === 'blocked') {
      this.enqueue('capture.blocked', async () => {
        await this.d.feishu.sendText(chatId, `页面需要登录或人工验证，已停止取数：${job?.url ?? ''}\n请在 Seller Agent「账号与浏览器」里打开货源站登录后再发一次，或者直接发截图。`);
      });
      return { ok: true };
    }
    if (body.status !== 'ok' || !body.capture) {
      this.enqueue('capture.failed', async () => {
        await this.d.feishu.sendText(chatId, `取数失败：${body.message ?? '未知错误'}`);
      });
      return { ok: true };
    }

    const capture = body.capture;
    this.enqueue('capture.pipeline', () => this.runPipeline(chatId, () =>
      structureCapture(this.d.claude, capture, platformOf(capture.url)), account));
    return { ok: true };
  }

  // ---------- 视频 ----------

  private videoDir(): string {
    const dir = this.d.config.videoDir ?? join(this.d.config.packageDir, '..', 'tts-videos');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private async fromFeishuVideo(chatId: string, messageId: string, content: any) {
    const dir = this.videoDir();
    const fileName: string = content.file_name || `${messageId}.mp4`;
    const { bytes } = await this.d.feishu.downloadResource(messageId, content.file_key, 'file');
    const stamp = new Date().toISOString().slice(0, 10);
    const filePath = join(dir, `${stamp}-${messageId.slice(-8)}${extname(fileName) || '.mp4'}`);
    writeFileSync(filePath, bytes);
    let coverPath: string | null = null;
    if (content.image_key) {
      try {
        const cover = await this.d.feishu.downloadResource(messageId, content.image_key, 'image');
        coverPath = filePath.replace(/\.[^.]+$/, '-cover.jpg');
        writeFileSync(coverPath, cover.bytes);
      } catch (err) {
        console.warn('[video.cover]', (err as Error).message);
      }
    }
    const account = this.account(null);
    const video = this.d.store.insertVideo({ accountId: account.id, filePath, coverPath, fileName, chatId });
    this.d.store.audit('video.received', null, { id: video.id, fileName });
    const msgId = await this.d.feishu.sendCard(chatId, videoAskCard(video, account.name));
    this.d.store.updateVideo(video.id, { messageId: msgId });
  }

  /** 桌面端添加本地视频。 */
  addLocalVideo(sourcePath: string, accountId?: string, coverSourcePath?: string): VideoRow {
    if (!existsSync(sourcePath)) throw new Error('视频文件不存在');
    const dir = this.videoDir();
    const stamp = new Date().toISOString().slice(0, 10);
    const target = join(dir, `${stamp}-${Date.now().toString(36)}${extname(sourcePath) || '.mp4'}`);
    copyFileSync(sourcePath, target);
    let coverPath: string | null = null;
    if (coverSourcePath && existsSync(coverSourcePath)) {
      coverPath = target.replace(/\.[^.]+$/, `-cover${extname(coverSourcePath)}`);
      copyFileSync(coverSourcePath, coverPath);
    }
    const account = this.account(accountId);
    const video = this.d.store.insertVideo({ accountId: account.id, filePath: target, coverPath, fileName: basename(sourcePath), chatId: null });
    this.d.store.audit('video.added', LOCAL_OPERATOR, { id: video.id });
    return video;
  }

  /** 选择挂车/曝光并生成文案。飞书按钮和桌面端共用。 */
  setVideoInfo(videoId: string, kind: 'shoppable' | 'exposure', productQuery: string, hint: string, operator: string, accountId?: string): { ok: boolean; message: string } {
    if (kind !== 'shoppable' && kind !== 'exposure') return { ok: false, message: '用途不对' };
    const v = this.d.store.video(videoId);
    if (!v) return { ok: false, message: '视频不存在' };
    if (!this.d.store.transitionVideo(videoId, ['awaiting_info', 'ready', 'failed'], 'generating')) return { ok: false, message: '这个视频正在处理或已经处理过' };

    const query = productQuery.trim();
    const draft = kind === 'shoppable' && query ? this.findDraft(query) : null;
    this.d.store.updateVideo(videoId, {
      kind, hint: hint.trim() || null, productQuery: query || null,
      draftId: draft?.id ?? null, productTitle: draft?.content.title ?? null,
      accountId: accountId ? this.account(accountId).id : v.accountId,
    });
    this.d.store.audit('video.info', operator, { videoId, kind, query });

    this.enqueue('video.caption', async () => {
      const current = this.d.store.video(videoId)!;
      try {
        let cover: { mediaType: string; base64: string } | null = null;
        if (current.coverPath && existsSync(current.coverPath)) {
          const ext = extname(current.coverPath).toLowerCase();
          cover = { mediaType: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg', base64: readFileSync(current.coverPath).toString('base64') };
        }
        const r = await generateCaption(this.d.claude, { kind, hint: current.hint, product: draft, cover });
        const notes = [...r.notes];
        if (r.hook) notes.unshift(`开头字幕建议：${r.hook}`);
        if (kind === 'shoppable' && !draft) notes.push(query ? `没有找到“${query}”对应的商品，发布时请手动挂车` : '没有指定挂车商品，发布时请手动选择');
        this.d.store.updateVideo(videoId, { caption: r.caption, hashtags: r.hashtags, notes, status: 'ready' });
      } catch (err) {
        this.d.store.updateVideo(videoId, { status: 'failed', notes: [`文案生成失败：${(err as Error).message}`] });
      }
      const done = this.d.store.video(videoId)!;
      const name = this.account(done.accountId).name;
      if (done.messageId) {
        await this.d.feishu.updateCard(done.messageId, done.status === 'ready' ? videoReadyCard(done, name) : statusCard('文案生成失败', 'red', done.notes));
      } else if (this.d.config.opsChatId && done.status === 'ready') {
        const msgId = await this.d.feishu.sendCard(this.d.config.opsChatId, videoReadyCard(done, name));
        if (msgId) this.d.store.updateVideo(videoId, { messageId: msgId });
      }
    });
    return { ok: true, message: '正在生成文案' };
  }

  /** 桌面端手动改文案。 */
  editVideoCaption(videoId: string, caption: string, hashtags: string[]) {
    this.d.store.updateVideo(videoId, { caption, hashtags: hashtags.map((h) => h.replace(/^#+/, '').trim()).filter(Boolean) });
  }

  markVideoPublished(videoId: string, operator: string): { ok: boolean; message: string } {
    if (!this.d.store.transitionVideo(videoId, ['ready'], 'published')) return { ok: false, message: '视频还没准备好或已经处理过' };
    this.d.store.updateVideo(videoId, { publishedAt: (this.d.now ?? Date.now)() });
    this.d.store.audit('video.published', operator, { videoId });
    return { ok: true, message: '已记录发布' };
  }

  rejectVideo(videoId: string) {
    return this.d.store.transitionVideo(videoId, ['awaiting_info', 'ready', 'failed'], 'rejected');
  }

  private findDraft(query: string): ListingDraft | null {
    for (const shopId of ['manual', ...this.d.store.shops().map((s) => s.id)]) {
      const m = this.d.store.skuMapping(shopId, query);
      if (m) return this.d.store.draft(m.draftId);
    }
    return this.d.store.searchDrafts(query, 1)[0] ?? null;
  }

  // ---------- 桌面端对半自动草稿的操作 ----------

  desktopManualAction(act: 'manual_reprice' | 'manual_done' | 'manual_reject', draftId: string, price?: number) {
    const toast = (type: string, content: string) => ({ toast: { type, content } });
    const op = this.d.config.localOperator ?? LOCAL_OPERATOR;
    let r: any;
    if (act === 'manual_reprice') r = this.onManualReprice(draftId, op, { price: String(price ?? '') }, toast);
    else if (act === 'manual_done') r = this.onManualDone(draftId, op, toast);
    else {
      r = this.d.store.transitionDraft(draftId, 'awaiting_manual', 'rejected') ? toast('info', '已放弃') : toast('warning', '这个商品已经处理过');
    }
    // 飞书里那张卡片也同步更新，避免两边状态不一致。
    const draft = this.d.store.draft(draftId);
    if (r.card && draft?._messageId) {
      this.enqueue('desktop.sync-card', () => this.d.feishu.updateCard(draft._messageId!, r.card.data));
    } else if (act === 'manual_reject' && draft?._messageId && r.toast.type === 'info') {
      this.enqueue('desktop.sync-card', () => this.d.feishu.updateCard(draft._messageId!, statusCard('已放弃', 'grey', ['这个商品不再处理。'])));
    }
    return r.toast as { type: string; content: string };
  }
}
