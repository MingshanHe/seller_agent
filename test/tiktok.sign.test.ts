import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sign, stringToSign, verifyWebhook, webhookSignature } from '../src/core/tiktok/sign.ts';

const load = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));

test('请求签名和全部测试向量一致', () => {
  const { cases } = load('tts-signing.json');
  assert.ok(cases.length >= 6);
  for (const c of cases) {
    const input = {
      path: c.path,
      query: c.query,
      contentType: c.contentType,
      body: c.body === null ? null : typeof c.body === 'string' ? c.body : JSON.stringify(c.body),
      appSecret: c.secret,
    };
    assert.equal(stringToSign(input), c.stringToSign, c.name);
    assert.equal(sign(input), c.sign, c.name);
  }
});

test('Webhook 验签和全部测试向量一致', () => {
  const { verify } = load('tts-webhooks.json');
  for (const v of verify) {
    const signature = v.signature;
    const expectedValid = v.valid ?? true;
    assert.equal(verifyWebhook(v.appKey, v.appSecret, v.rawBody, signature), expectedValid, v.name);
  }
});

test('大写签名无效', () => {
  const sig = webhookSignature('k', 's', '{}');
  assert.equal(verifyWebhook('k', 's', '{}', sig), true);
  assert.equal(verifyWebhook('k', 's', '{}', sig.toUpperCase()), false);
  assert.equal(verifyWebhook('k', 's', '{}', ''), false);
});
