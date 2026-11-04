import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateSignature, decryptEvent, verifySignature } from '../src/core/feishu/crypto.ts';
import { draftCard, purchaseCard } from '../src/core/feishu/cards.ts';

test('解密官方文档的示例密文', () => {
  assert.equal(decryptEvent('P37w+VZImNgPEO1RBhJ6RtKl7n6zymIbEG1pReEzghk=', 'test key'), 'hello world');
});

test('签名按 timestamp + nonce + key + body 计算', () => {
  const sig = calculateSignature('1', '2', 'k', '{}');
  // printf '12k{}' | sha256sum
  assert.equal(sig, 'a2c08cfc1732e85c101a8e8b6dfeddbe44d732caedfb06a1dd08711e6398a656');
  assert.equal(verifySignature({ timestamp: '1', nonce: '2', encryptKey: 'k', rawBody: '{}', signature: sig }), true);
  assert.equal(verifySignature({ timestamp: '1', nonce: '2', encryptKey: 'k', rawBody: '{ }', signature: sig }), false);
});

test('卡片里的外部文字被转义，不能注入 markdown 链接', () => {
  const draft: any = {
    id: 'd', content: { title: '[点我](https://evil.example)', descriptionParagraphs: [] }, categoryPath: ['A'], source: { url: 'u' },
    previewImageKeys: [], notes: [], listingRoute: 'local', risk: 'pass',
    check: { passed: true, failReasons: [], warnings: [] }, skus: [],
    pricing: { decision: 'ok', reasons: [], skus: [], market: null, commissionRate: 0.1, billableGrams: 1, crossBorderCny: 36, fxCnyJpy: 21 },
  };
  const text = JSON.stringify(draftCard(draft, 'a'));
  assert.ok(text.includes('\\\\[点我\\\\]'));
});

test('打开货源按钮是跳转，不会回调服务器', () => {
  const card = purchaseCard({
    task: { id: 't', orderId: 'o', quantity: 1, saleJpy: 1980 } as any,
    mapping: { specText: '颜色：蓝色', sourceUrl: 'https://detail.1688.com/offer/1.html' } as any,
    productName: '水杯', profitJpy: 300, marginRate: 0.15, costCny: 18, deadlineText: '明天',
  });
  const btn = (card.body.elements as any[]).find((e) => e.text?.content === '打开货源');
  assert.deepEqual(btn.behaviors, [{ type: 'open_url', default_url: 'https://detail.1688.com/offer/1.html' }]);
});
