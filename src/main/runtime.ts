// 把核心引擎按桌面配置接起来：飞书长连接（不需要公网服务器）、内置浏览器取数、定时任务。
import * as lark from '@larksuiteoapi/node-sdk';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { App, LOCAL_OPERATOR, type HttpRequest } from '../core/app.ts';
import { Store } from '../core/db.ts';
import { FeishuClient } from '../core/feishu/client.ts';
import { Claude } from '../core/llm/claude.ts';
import { ImageTranslator } from '../core/listing/images.ts';
import { sendReminders } from '../core/orders/flow.ts';
import type { PricingConfig } from '../core/pricing/engine.ts';
import { FxProvider } from '../core/pricing/fx.ts';
import { TikTokClient } from '../core/tiktok/client.ts';
import { CaptureWorker } from './browser.ts';
import { dataPath, ensurePricing, type DesktopConfig } from './config.ts';

/** 飞书没配置或没有会话 ID 时不报错，只记日志。这样不接飞书也能在桌面端用。 */
/** 所有发给飞书的消息也记一份，桌面端“通知”里能看到。 */
export interface Notice { at: number; text: string; kind: 'text' | 'card' }

class LocalFeishu extends FeishuClient {
  private enabled: boolean;
  readonly notices: Notice[] = [];
  constructor(enabled: boolean, opts: ConstructorParameters<typeof FeishuClient>[0]) {
    super(opts);
    this.enabled = enabled;
  }
  private note(kind: Notice['kind'], text: string) {
    this.notices.push({ at: Date.now(), text, kind });
    if (this.notices.length > 100) this.notices.shift();
    console.log(`[${kind === 'card' ? '卡片' : '通知'}] ${text.slice(0, 500)}`);
  }
  override async sendText(chatId: string, text: string): Promise<string> {
    this.note('text', text);
    if (!this.enabled || !chatId) return '';
    return super.sendText(chatId, text);
  }
  override async sendCard(chatId: string, card: unknown): Promise<string> {
    this.note('card', (card as any)?.header?.title?.content ?? '卡片');
    if (!this.enabled || !chatId) return '';
    return super.sendCard(chatId, card);
  }
  override async updateCard(messageId: string, card: unknown): Promise<void> {
    if (!this.enabled || !messageId) return;
    return super.updateCard(messageId, card);
  }
  override async uploadImage(bytes: Uint8Array, filename: string): Promise<string> {
    if (!this.enabled) throw new Error('飞书未配置，跳过预览图');
    return super.uploadImage(bytes, filename);
  }
}

export type FeishuState = 'off' | 'connecting' | 'connected' | 'error';

export class Runtime {
  readonly cfg: DesktopConfig;
  readonly store: Store;
  readonly app: App;
  readonly feishu: LocalFeishu;
  readonly claude: Claude;
  readonly capture: CaptureWorker;
  pricing: PricingConfig;
  feishuState: FeishuState = 'off';
  feishuError = '';
  private ws: lark.WSClient | null = null;
  private http: Server | null = null;
  private timers: NodeJS.Timeout[] = [];

  constructor(cfg: DesktopConfig) {
    this.cfg = cfg;
    const fetchImpl = globalThis.fetch.bind(globalThis);
    this.pricing = JSON.parse(readFileSync(ensurePricing(), 'utf8'));
    this.store = new Store(dataPath());
    const tiktok = new TikTokClient({ appKey: cfg.tiktok.appKey, appSecret: cfg.tiktok.appSecret, fetchImpl });
    const feishuOn = Boolean(cfg.feishu.appId && cfg.feishu.appSecret);
    this.feishu = new LocalFeishu(feishuOn, { appId: cfg.feishu.appId, appSecret: cfg.feishu.appSecret, fetchImpl });
    this.claude = new Claude({ apiKey: cfg.claude.apiKey, model: cfg.claude.model || 'claude-sonnet-5-5', fetchImpl });
    const fx = new FxProvider({
      fetchImpl,
      fixed: { 'CNY/JPY': Number(cfg.fx.cnyJpy) || undefined, 'USD/JPY': Number(cfg.fx.usdJpy) || undefined },
    });
    const translator = cfg.dashscope.apiKey && cfg.dashscope.baseUrl
      ? new ImageTranslator({ apiKey: cfg.dashscope.apiKey, baseUrl: cfg.dashscope.baseUrl, model: cfg.dashscope.model || 'qwen-mt-image-2.0', fetchImpl })
      : null;

    this.app = new App({
      config: {
        ttsAppKey: cfg.tiktok.appKey,
        ttsAppSecret: cfg.tiktok.appSecret,
        ttsServiceId: cfg.tiktok.serviceId,
        feishuVerificationToken: '',
        feishuEncryptKey: '',
        adminOpenIds: cfg.feishu.adminOpenIds.split(',').map((s) => s.trim()).filter(Boolean),
        opsChatId: cfg.feishu.opsChatId,
        captureToken: '',
        packageDir: cfg.paths.packageDir,
        videoDir: cfg.paths.videoDir,
        accounts: cfg.accounts,
        defaultAccountId: cfg.defaultAccountId,
        localOperator: LOCAL_OPERATOR,
      },
      store: this.store,
      tiktok,
      feishu: this.feishu,
      claude: this.claude,
      fx,
      pricing: this.pricing,
      pipeline: {
        tiktok, claude: this.claude, translator, fx, fetchImpl, pricing: this.pricing,
        marketKeys: { rakutenAppId: cfg.market.rakutenAppId, rakutenAccessKey: cfg.market.rakutenAccessKey, yahooAppId: cfg.market.yahooAppId },
      },
    });

    this.capture = new CaptureWorker({
      next: () => this.store.nextCapture(),
      complete: (body) => { this.app.completeCapture(body); },
      hourlyLimit: () => this.cfg.capture.hourlyLimit || 30,
      showWindow: () => this.cfg.capture.showWindow,
    });
  }

  start() {
    this.capture.start();
    this.startFeishu();
    if (this.cfg.tiktok.appKey && this.cfg.tiktok.appSecret) this.startHttp();

    const guard = (label: string, fn: () => Promise<void>) => fn().catch((e) => console.error(`[${label}]`, e));
    this.timers.push(
      setInterval(() => guard('refreshTokens', () => this.app.refreshTokens()), 3600_000),
      setInterval(() => guard('reminders', () => sendReminders(this.app.orders)), 300_000),
      setInterval(() => guard('captures', () => this.app.expireCaptures()), 60_000),
      setInterval(() => guard('inbox', () => this.app.processInbox()), 60_000),
    );
    guard('recover', () => this.app.recover());
    guard('inbox', () => this.app.processInbox());
    guard('refreshTokens', () => this.app.refreshTokens());
    console.log(`[runtime] 已启动：${this.store.shops().length > 0 ? '接口模式' : '半自动模式（没有 AM / 未授权 TikTok 接口）'}`);
  }

  /** 飞书长连接：在开发者后台把“事件订阅”和“回调订阅”都设成“使用长连接接收”。 */
  private startFeishu() {
    const { appId, appSecret } = this.cfg.feishu;
    if (!appId || !appSecret) {
      this.feishuState = 'off';
      return;
    }
    this.feishuState = 'connecting';
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        this.app.feishuMessage(data, data?.event_id);
      },
      'card.action.trigger': async (data: any) => this.app.feishuCardAction(data),
    } as any);
    try {
      this.ws = new lark.WSClient({
        appId,
        appSecret,
        loggerLevel: lark.LoggerLevel.warn,
        logger: {
          error: (...a: any[]) => { this.feishuError = a.map(String).join(' '); console.error('[飞书]', ...a); },
          warn: (...a: any[]) => console.warn('[飞书]', ...a),
          info: (...a: any[]) => console.log('[飞书]', ...a),
          debug: () => {},
          trace: () => {},
        },
      } as any);
      this.ws.start({ eventDispatcher: dispatcher })
        .then(() => { this.feishuState = 'connected'; console.log('[飞书] 长连接已建立'); })
        .catch((e: any) => { this.feishuState = 'error'; this.feishuError = String(e?.message ?? e); console.error('[飞书] 长连接失败', e); });
    } catch (e) {
      this.feishuState = 'error';
      this.feishuError = String((e as Error).message);
    }
  }

  /** 只监听本机。TikTok 授权回调地址填 http://localhost:端口/tts/oauth/callback。 */
  private startHttp() {
    const port = this.cfg.tiktok.port || 8787;
    this.http = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const url = new URL(req.url ?? '/', 'http://localhost');
        const request: HttpRequest = {
          method: req.method ?? 'GET', path: url.pathname, query: url.searchParams,
          headers: req.headers as Record<string, string>, rawBody: Buffer.concat(chunks).toString('utf8'),
        };
        const out = await this.app.handle(request);
        res.writeHead(out.status, { 'content-type': out.contentType ?? 'text/plain; charset=utf-8' });
        res.end(out.body);
      } catch (err) {
        console.error('[http]', err);
        res.writeHead(500).end('{}');
      }
    });
    this.http.on('error', (e) => console.error('[http] 端口启动失败', e.message));
    this.http.listen(port, '127.0.0.1', () => console.log(`[http] 本机回调服务 http://localhost:${port}`));
  }

  async stop() {
    this.capture.stop();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    try { (this.ws as any)?.close?.({ force: true }); } catch { /* ignore */ }
    this.ws = null;
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()));
    await this.app.idle().catch(() => {});
    this.store.close();
  }

  status() {
    return {
      mode: this.store.shops().length > 0 ? 'api' : 'manual',
      feishu: this.feishuState,
      feishuError: this.feishuError,
      claude: Boolean(this.cfg.claude.apiKey),
      translator: Boolean(this.cfg.dashscope.apiKey && this.cfg.dashscope.baseUrl),
      market: Boolean(this.cfg.market.rakutenAppId || this.cfg.market.yahooAppId),
      capturing: this.capture.current,
      drafts: this.store.countDrafts(),
      videos: this.store.countVideos(),
      tasks: this.store.countTasks(),
      shops: this.store.shops().map((s) => ({ id: s.id, name: s.name, region: s.region })),
      notices: this.feishu.notices.slice(-30),
    };
  }
}
