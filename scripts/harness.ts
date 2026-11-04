// 用模拟世界搭一个完整 App。测试和演示共用。
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { App, type HttpResponse } from '../src/core/app.ts';
import { Store } from '../src/core/db.ts';
import { FeishuClient } from '../src/core/feishu/client.ts';
import { Claude } from '../src/core/llm/claude.ts';
import { ImageTranslator } from '../src/core/listing/images.ts';
import type { PricingConfig } from '../src/core/pricing/engine.ts';
import { FxProvider } from '../src/core/pricing/fx.ts';
import { TikTokClient } from '../src/core/tiktok/client.ts';
import { webhookSignature } from '../src/core/tiktok/sign.ts';
import { createWorld, type World, type WorldOptions } from './fake-world.ts';

export const ADMIN = 'ou_admin';
export const CHAT = 'oc_ops';
export const CAPTURE_TOKEN = 'capture-secret';
export const ENCRYPT_KEY = 'test encrypt key';
export const VERIFY_TOKEN = 'verify-token';

export const loadPricing = (): PricingConfig =>
  JSON.parse(readFileSync(new URL('../config/pricing.jp.json', import.meta.url), 'utf8'));

export interface Harness {
  app: App;
  world: World;
  store: Store;
  pricing: PricingConfig;
  feishuEvent(event: object, eventType?: string): Promise<HttpResponse>;
  sendText(text: string, sender?: string): Promise<HttpResponse>;
  cardClick(value: object, form?: object, operator?: string): Promise<any>;
  ttsWebhook(payload: object): Promise<HttpResponse>;
  submitCapture(jobId?: string, url?: string): Promise<HttpResponse>;
  linkAndCapture(url?: string): Promise<void>;
  lastCard(): any;
  actionValue(card: any, act: string): any;
}

const noSleep = async () => {};

export function createHarness(options: WorldOptions = {}, overrides: { pricing?: Partial<PricingConfig>; noShop?: boolean; dbPath?: string; packageDir?: string } = {}): Harness {
  const world = createWorld(options);
  const { fetchImpl } = world;
  const pricing = { ...loadPricing(), ...overrides.pricing };
  const store = new Store(overrides.dbPath ?? ':memory:');
  const tiktok = new TikTokClient({ appKey: world.appKey, appSecret: world.appSecret, fetchImpl, sleep: noSleep });
  const feishu = new FeishuClient({ appId: 'cli_x', appSecret: 's', fetchImpl });
  const claude = new Claude({ apiKey: 'k', model: 'claude-sonnet-5-5', fetchImpl, sleep: noSleep });
  const fx = new FxProvider({ fetchImpl });
  const translator = new ImageTranslator({
    apiKey: 'k', baseUrl: 'https://dashscope.example.aliyuncs.com', model: 'qwen-mt-image-2.0', fetchImpl, sleep: noSleep,
  });

  if (!overrides.noShop) store.saveShop({
    id: 'shop-1', cipher: 'cipher-1', name: '测试店', region: 'JP',
    accessToken: 'at-0', accessTokenExpireAt: Math.floor(Date.now() / 1000) + 5 * 86400,
    refreshToken: 'rt-0', refreshTokenExpireAt: Math.floor(Date.now() / 1000) + 60 * 86400,
  });

  const app = new App({
    config: {
      ttsAppKey: world.appKey, ttsAppSecret: world.appSecret, ttsServiceId: 'svc-1',
      feishuVerificationToken: VERIFY_TOKEN, feishuEncryptKey: '',
      adminOpenIds: [ADMIN], opsChatId: CHAT, captureToken: CAPTURE_TOKEN,
      packageDir: overrides.packageDir ?? mkdtempSync(join(tmpdir(), 'tts-packages-')),
    },
    store, tiktok, feishu, claude, fx, pricing,
    pipeline: {
      tiktok, claude, translator, fx, fetchImpl, pricing,
      marketKeys: { rakutenAppId: 'r', rakutenAccessKey: 'k', yahooAppId: 'y' },
    },
  });

  let eventSeq = 0;
  const request = (method: string, path: string, rawBody = '', headers: Record<string, string> = {}, query = '') =>
    app.handle({ method, path, query: new URLSearchParams(query), headers, rawBody });

  const h: Harness = {
    app, world, store, pricing,
    feishuEvent(event, eventType = 'im.message.receive_v1') {
      return request('POST', '/feishu/events', JSON.stringify({
        schema: '2.0',
        header: { event_id: `e-${++eventSeq}`, token: VERIFY_TOKEN, event_type: eventType },
        event,
      }));
    },
    sendText(text, sender = ADMIN) {
      return h.feishuEvent({
        sender: { sender_id: { open_id: sender } },
        message: { message_id: `m-${eventSeq}`, chat_id: CHAT, message_type: 'text', content: JSON.stringify({ text }) },
      });
    },
    async cardClick(value, form = {}, operator = ADMIN) {
      const res = await h.feishuEvent({
        operator: { open_id: operator },
        action: { value, form_value: form, tag: 'button' },
        context: { open_message_id: 'om_x', open_chat_id: CHAT },
      }, 'card.action.trigger');
      return JSON.parse(res.body);
    },
    ttsWebhook(payload) {
      const rawBody = JSON.stringify(payload);
      return request('POST', '/tts/webhook', rawBody, {
        authorization: webhookSignature(world.appKey, world.appSecret, rawBody),
      });
    },
    submitCapture(jobId, url = 'https://detail.1688.com/offer/123.html') {
      return request('POST', '/capture/result', JSON.stringify({
        jobId,
        status: 'ok',
        capture: {
          url,
          title: '保温杯',
          text: options.captureText ?? `304不锈钢保温杯 蓝色 ¥${options.priceCny ?? 18}\n黑色 ¥${(options.priceCny ?? 18) + 3}`,
          images: [1, 2, 3, 4, 5].map((i) => `https://cbu01.alicdn.com/img/${i}.jpg`),
        },
      }), { authorization: `Bearer ${CAPTURE_TOKEN}` });
    },
    async linkAndCapture(url = 'https://detail.1688.com/offer/123.html') {
      await h.sendText(`上架这个 ${url}`);
      await app.idle();
      const next = await request('GET', '/capture/next', '', { authorization: `Bearer ${CAPTURE_TOKEN}` });
      const { job } = JSON.parse(next.body);
      await h.submitCapture(job.id, url);
      await app.idle();
    },
    lastCard() {
      return [...world.feishuMessages].reverse().find((m) => m.type === 'interactive')?.content;
    },
    actionValue(card, act) {
      const walk = (n: any): any => {
        if (!n || typeof n !== 'object') return null;
        for (const b of n.behaviors ?? []) if (b.value?.act === act) return b.value;
        for (const v of Object.values(n)) {
          const found = walk(v);
          if (found) return found;
        }
        return null;
      };
      return walk(card);
    },
  };
  return h;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
