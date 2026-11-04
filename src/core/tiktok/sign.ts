// TikTok Shop 请求签名和 Webhook 验签。
// 用官方文档的算例和开源 SDK 的测试向量校验过，见 test/tiktok.sign.test.ts。
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignInput {
  path: string;
  query: [string, string][];
  contentType: string | null;
  body: string | Uint8Array | null;
  appSecret: string;
}

const EXCLUDED = new Set(['sign', 'access_token']);

function isMultipart(contentType: string | null): boolean {
  if (!contentType) return false;
  return contentType.split(';')[0].trim().toLowerCase() === 'multipart/form-data';
}

export function stringToSign(req: SignInput): string {
  const params = req.query
    .filter(([k]) => !EXCLUDED.has(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let s = req.path + params.map(([k, v]) => k + v).join('');
  if (req.body && req.body.length > 0 && !isMultipart(req.contentType)) {
    s += typeof req.body === 'string' ? req.body : Buffer.from(req.body).toString('utf8');
  }
  return req.appSecret + s + req.appSecret;
}

export function sign(req: SignInput): string {
  return createHmac('sha256', req.appSecret).update(stringToSign(req), 'utf8').digest('hex');
}

export function webhookSignature(appKey: string, appSecret: string, rawBody: string): string {
  return createHmac('sha256', appSecret).update(appKey + rawBody, 'utf8').digest('hex');
}

/** 大小写敏感比较：官方要求小写十六进制。 */
export function verifyWebhook(appKey: string, appSecret: string, rawBody: string, signature: string): boolean {
  const expected = Buffer.from(webhookSignature(appKey, appSecret, rawBody));
  const actual = Buffer.from(signature ?? '');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
