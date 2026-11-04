// Claude Messages API：只用结构化输出，模型没有任何工具。
// 这样网页和买家文字里的注入内容最多影响文案，碰不到写接口。
import type { FetchLike } from '../types.ts';

const URL_MESSAGES = 'https://api.anthropic.com/v1/messages';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'url'; url: string } | { type: 'base64'; media_type: string; data: string } };

export interface ClaudeOptions {
  apiKey: string;
  model: string;
  fetchImpl: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Claude {
  private o: ClaudeOptions;

  constructor(options: ClaudeOptions) {
    this.o = options;
  }

  async structured<T>(args: { system: string; content: ContentBlock[]; schema: object; maxTokens?: number }): Promise<T> {
    if (!this.o.apiKey) throw new Error('还没有配置 Claude API Key，请在「设置」里填写');
    const body = JSON.stringify({
      model: this.o.model,
      max_tokens: args.maxTokens ?? 4096,
      system: args.system,
      messages: [{ role: 'user', content: args.content }],
      output_config: { format: { type: 'json_schema', schema: args.schema } },
    });

    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await (this.o.sleep ?? wait)(1000 * 2 ** attempt);
      const res = await this.o.fetchImpl(URL_MESSAGES, {
        method: 'POST',
        headers: {
          'x-api-key': this.o.apiKey,
          'anthropic-version': '2026-10-21',
          'content-type': 'application/json',
        },
        body,
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`Claude 接口返回 ${res.status}`);
        continue;
      }
      const data: any = await res.json();
      if (!res.ok) throw new Error(`Claude 接口错误：${data?.error?.message ?? res.status}`);
      if (data.stop_reason === 'refusal') throw new Error('Claude 拒绝处理这段内容');
      if (data.stop_reason === 'max_tokens') throw new Error('Claude 输出被截断，需要加大 max_tokens');
      const text = (data.content ?? []).find((b: any) => b.type === 'text')?.text;
      if (!text) throw new Error('Claude 没有返回文本');
      return JSON.parse(text) as T;
    }
    throw lastError;
  }
}
