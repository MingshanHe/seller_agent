// 飞书事件的验签和解密，算法见官方“接收事件”文档。
import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';

export function calculateSignature(timestamp: string, nonce: string, encryptKey: string, rawBody: string): string {
  return createHash('sha256').update(timestamp + nonce + encryptKey + rawBody, 'utf8').digest('hex');
}

export function verifySignature(args: { timestamp: string; nonce: string; encryptKey: string; rawBody: string; signature: string }): boolean {
  const expected = Buffer.from(calculateSignature(args.timestamp, args.nonce, args.encryptKey, args.rawBody));
  const actual = Buffer.from(args.signature ?? '');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** AES-256-CBC：密钥是 Encrypt Key 的 SHA-256，密文前 16 字节是 IV。 */
export function decryptEvent(encrypted: string, encryptKey: string): string {
  const buf = Buffer.from(encrypted, 'base64');
  if (buf.length < 32) throw new Error('密文太短');
  const key = createHash('sha256').update(encryptKey, 'utf8').digest();
  const decipher = createDecipheriv('aes-256-cbc', key, buf.subarray(0, 16));
  return Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]).toString('utf8');
}
