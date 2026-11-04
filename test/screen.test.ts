import test from 'node:test';
import assert from 'node:assert/strict';
import { contactHits, overallRisk, screenSource, simplifiedChineseHits } from '../src/core/listing/screen.ts';
import { downloadImage, isAllowedImageUrl, isTranslatorResultUrl } from '../src/core/listing/images.ts';
import { priceInText } from '../src/core/listing/llm.ts';
import { isCapturable } from '../src/core/app.ts';

const s = (title: string) => ({ title, description: '', attributes: [] });

test('仿冒词直接拦截', () => {
  assert.equal(overallRisk(screenSource(s('高仿 手表'))), 'block');
});

test('制限类目和认证进入人工确认', () => {
  assert.equal(overallRisk(screenSource(s('蓝牙耳机 带充电宝'))), 'review');
  assert.equal(overallRisk(screenSource(s('宠物 饮水机'))), 'review');
  assert.equal(overallRisk(screenSource(s('不锈钢水杯'))), 'pass');
});

test('简体字检测不误伤日语常用汉字', () => {
  assert.deepEqual(simplifiedChineseHits('ステンレス水筒 真空二重構造 500ml 毎日の持ち運びに便利です。国内発送、机の上で使えます'), []);
  assert.deepEqual(simplifiedChineseHits('这款水杯').sort(), ['这']);
  assert.ok(simplifiedChineseHits('优质产品').length >= 2);
});

test('简体字表覆盖常见商品词，日语商品文案不误报', () => {
  assert.ok(simplifiedChineseHits('不锈钢保温杯').length >= 2);
  assert.ok(simplifiedChineseHits('蓝色').length >= 1);
  assert.ok(simplifiedChineseHits('绿色 红色').length >= 2);
  const ja = '素材：ステンレス鋼 容量：500ml 色：ブルー、ブラック 保温 保冷 軽量 送料無料 新品 人気 お弁当 台所 風呂 収納 洗濯 掃除 充電 電池 無線 有線 防水 耐熱 耐久 高品質 便利 簡単 組立 説明書 付属品 机 番号 学校 午後 取扱説明 日本語 国内 発送 価格 商品 男女兼用 子供 大人 春夏秋冬 登山 旅行 通勤 通学 贈り物';
  assert.deepEqual(simplifiedChineseHits(ja), []);
});

test('站外联系方式检测', () => {
  assert.deepEqual(contactHits('ステンレス水筒 500ml 2024年モデル 12時間保温'), []);
  assert.ok(contactHits('詳細は https://example.com へ').includes('网址'));
  assert.ok(contactHits('LINE ID: abc').includes('站外联系方式'));
  assert.ok(contactHits('お問い合わせ a@b.jp').includes('邮箱'));
  assert.ok(contactHits('TEL 03-1234-5678').includes('电话'));
  assert.ok(contactHits('微信 abc').includes('站外联系方式'));
});

test('价格核对：在页面文字里找金额', () => {
  assert.equal(priceInText(18, '价格 ¥18.00 起批'), true);
  assert.equal(priceInText(18, '¥ 18 元'), true);
  assert.equal(priceInText(18.5, '¥\n18\n.50'), true);
  assert.equal(priceInText(18, '¥118 或 ¥18.5'), false);
  assert.equal(priceInText(8, '售价 18'), false);
});

test('只接受允许的图片地址', () => {
  assert.equal(isAllowedImageUrl('https://cbu01.alicdn.com/img/1.jpg'), true);
  assert.equal(isAllowedImageUrl('https://attacker.oss-cn-beijing.aliyuncs.com/a.jpg'), false);
  assert.equal(isTranslatorResultUrl('https://dashscope-result.oss-cn-beijing.aliyuncs.com/a.jpg'), true);
  assert.equal(isTranslatorResultUrl('http://dashscope-result.oss-cn-beijing.aliyuncs.com/a.jpg'), false);
  assert.equal(isAllowedImageUrl('http://cbu01.alicdn.com/img/1.jpg'), false);
  assert.equal(isAllowedImageUrl('https://169.254.169.254/latest/meta-data'), false);
  assert.equal(isAllowedImageUrl('https://localhost/a.jpg'), false);
  assert.equal(isAllowedImageUrl('https://alicdn.com.evil.example/a.jpg'), false);
  assert.equal(isAllowedImageUrl('不是地址'), false);
});

test('下载图片时不跟随跳转', async () => {
  let init: RequestInit | undefined;
  await downloadImage(async (_u, i) => { init = i; return new Response(new Uint8Array([1])); }, 'https://cbu01.alicdn.com/1.jpg');
  assert.equal(init?.redirect, 'error');
  await assert.rejects(downloadImage(async () => new Response('x'), 'https://attacker.oss-cn-beijing.aliyuncs.com/a.jpg'));
});

test('只有已知货源站能交给插件', () => {
  assert.equal(isCapturable('https://detail.1688.com/offer/1.html'), true);
  assert.equal(isCapturable('https://item.taobao.com/item.htm?id=1'), true);
  assert.equal(isCapturable('http://detail.1688.com/offer/1.html'), false);
  assert.equal(isCapturable('https://1688.com.evil.example/a'), false);
  assert.equal(isCapturable('https://example.com/a'), false);
});
