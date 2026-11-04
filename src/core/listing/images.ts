// 图片翻译：阿里云百炼 Qwen-MT-Image。先建任务，再轮询结果。
import type { FetchLike } from '../types.ts';

export interface ImageTranslatorOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchImpl: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  maxPolls?: number;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ImageTranslator {
  private o: ImageTranslatorOptions;

  constructor(options: ImageTranslatorOptions) {
    this.o = options;
  }

  /** 返回翻译后的图片地址。没有可翻译文字时返回 null，调用方继续用原图。 */
  async translate(imageUrl: string): Promise<string | null> {
    const headers = {
      authorization: `Bearer ${this.o.apiKey}`,
      'content-type': 'application/json',
      'X-DashScope-Async': 'enable',
    };
    const create = await this.o.fetchImpl(`${this.o.baseUrl}/api/v1/services/aigc/image2image/image-synthesis`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.o.model,
        input: {
          image_url: imageUrl,
          source_lang: 'zh',
          target_lang: 'ja',
          // 跳过商品本体和 logo 上的文字。
          ext: { config: { imageSegment: true } },
        },
      }),
    });
    const created: any = await create.json();
    const taskId = created?.output?.task_id;
    if (!taskId) throw new Error(`图片翻译建任务失败：${created?.message ?? create.status}`);

    for (let i = 0; i < (this.o.maxPolls ?? 30); i++) {
      await (this.o.sleep ?? wait)(2000);
      const res = await this.o.fetchImpl(`${this.o.baseUrl}/api/v1/tasks/${taskId}`, {
        headers: { authorization: `Bearer ${this.o.apiKey}` },
      });
      const d: any = await res.json();
      const status = d?.output?.task_status;
      if (status === 'SUCCEEDED') return d.output.image_url ?? null;
      if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
        throw new Error(`图片翻译失败：${d?.output?.message ?? status}`);
      }
    }
    throw new Error('图片翻译超时');
  }
}

// 图片地址来自外部网页，只允许这些 CDN，防止服务器被诱导去请求内网地址。
const IMAGE_HOSTS = [/\.alicdn\.com$/i, /\.1688\.com$/i, /\.taobao\.com$/i, /\.taobaocdn\.com$/i, /\.tbcdn\.cn$/i, /\.pddpic\.com$/i, /\.yangkeduo\.com$/i];

export function isAllowedImageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && IMAGE_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

/** 只有图片翻译接口返回的地址才走这里，网页上的地址不算。 */
export function isTranslatorResultUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname.endsWith('.aliyuncs.com');
  } catch {
    return false;
  }
}

export async function downloadImage(fetchImpl: FetchLike, url: string, opts: { translatorResult?: boolean } = {}): Promise<Uint8Array> {
  const allowed = opts.translatorResult ? isTranslatorResultUrl(url) : isAllowedImageUrl(url);
  if (!allowed) throw new Error('图片地址不在允许的列表里');
  // 不跟随跳转，否则白名单里的地址可以把请求转到内网。
  const res = await fetchImpl(url, { redirect: 'error' });
  if (!res.ok) throw new Error(`下载图片失败：${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error('图片是空文件');
  if (bytes.length > 10 * 1024 * 1024) throw new Error('图片超过 10 MB');
  return bytes;
}
