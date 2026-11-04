// 飞书开放接口：租户令牌、发消息、更新卡片、上传图片、下载消息资源。
import type { FetchLike } from '../types.ts';

const BASE = 'https://open.feishu.cn/open-apis';

export interface FeishuOptions {
  appId: string;
  appSecret: string;
  fetchImpl: FetchLike;
  now?: () => number;
}

export class FeishuClient {
  private o: FeishuOptions;
  private token: { value: string; expireAt: number } | null = null;

  constructor(options: FeishuOptions) {
    this.o = options;
  }

  private async tenantToken(): Promise<string> {
    const now = (this.o.now ?? Date.now)();
    if (this.token && now < this.token.expireAt - 60_000) return this.token.value;
    const res = await this.o.fetchImpl(`${BASE}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.o.appId, app_secret: this.o.appSecret }),
    });
    const d: any = await res.json();
    if (d.code !== 0) throw new Error(`飞书令牌失败：${d.msg}`);
    this.token = { value: d.tenant_access_token, expireAt: now + d.expire * 1000 };
    return this.token.value;
  }

  private async api(method: string, path: string, body?: unknown): Promise<any> {
    const res = await this.o.fetchImpl(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.tenantToken()}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const d: any = await res.json();
    if (d.code !== 0) throw new Error(`飞书接口 ${path} 失败：${d.code} ${d.msg}`);
    return d.data;
  }

  async sendText(chatId: string, text: string): Promise<string> {
    const d = await this.api('POST', '/im/v1/messages?receive_id_type=chat_id', {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    });
    return d.message_id;
  }

  async sendCard(chatId: string, card: unknown): Promise<string> {
    const d = await this.api('POST', '/im/v1/messages?receive_id_type=chat_id', {
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    });
    return d.message_id;
  }

  async updateCard(messageId: string, card: unknown): Promise<void> {
    await this.api('PATCH', `/im/v1/messages/${messageId}`, { content: JSON.stringify(card) });
  }

  async uploadImage(bytes: Uint8Array, filename: string): Promise<string> {
    const form = new FormData();
    form.set('image_type', 'message');
    form.set('image', new Blob([bytes.slice()]), filename);
    const res = await this.o.fetchImpl(`${BASE}/im/v1/images`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.tenantToken()}` },
      body: form,
    });
    const d: any = await res.json();
    if (d.code !== 0) throw new Error(`飞书上传图片失败：${d.msg}`);
    return d.data.image_key;
  }

  /** 机器人必须在会话内，文件不超过 100 MB。 */
  async downloadResource(messageId: string, fileKey: string, type: 'image' | 'file'): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const res = await this.o.fetchImpl(`${BASE}/im/v1/messages/${messageId}/resources/${fileKey}?type=${type}`, {
      headers: { authorization: `Bearer ${await this.tenantToken()}` },
    });
    if (!res.ok) throw new Error(`飞书下载资源失败：${res.status}`);
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      mediaType: res.headers.get('content-type') ?? 'image/jpeg',
    };
  }
}
