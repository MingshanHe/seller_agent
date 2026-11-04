// 视频：飞书发视频 → 选挂车/曝光 → Claude 写文案 → 记录发布。还有多账号路由和桌面端入口。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMIN, CHAT, createHarness } from '../scripts/harness.ts';
import { LOCAL_OPERATOR } from '../src/core/app.ts';
import { postText } from '../src/core/video.ts';

function sendVideo(h: ReturnType<typeof createHarness>, id = 'm-video-1') {
  return h.feishuEvent({
    sender: { sender_id: { open_id: ADMIN } },
    message: {
      message_id: id, chat_id: CHAT, message_type: 'media',
      content: JSON.stringify({ file_key: 'file_v1', image_key: 'img_cover', file_name: 'demo.mp4', duration: 15000 }),
    },
  });
}

test('飞书发视频，选挂车并关联已上架商品，生成日文文案', async () => {
  const h = createHarness({}, { noShop: true });
  await h.linkAndCapture();
  const draft = h.store.listDrafts()[0];
  await h.cardClick({ act: 'manual_done', draftId: draft.id });

  await sendVideo(h);
  await h.app.idle();
  const ask = h.lastCard();
  assert.equal(ask.header.title.content, '收到视频：选择用途');
  const video = h.store.listVideos()[0];
  assert.equal(video.status, 'awaiting_info');
  assert.ok(existsSync(video.filePath));
  assert.ok(video.coverPath && existsSync(video.coverPath));

  const value = h.actionValue(ask, 'video_kind');
  const r = await h.cardClick(value, { product: draft.skus[0].sellerSku, hint: '夏场景' });
  assert.equal(r.toast.type, 'info');
  await h.app.idle();

  const ready = h.store.video(video.id)!;
  assert.equal(ready.status, 'ready');
  assert.equal(ready.kind, 'shoppable');
  assert.equal(ready.draftId, draft.id);
  assert.deepEqual(ready.hashtags, ['TikTok売れ筋', '便利グッズ', 'fyp']);
  assert.match(postText(ready), /#便利グッズ/);
  const updated = h.world.feishuUpdates.at(-1)!;
  assert.match(updated.content.header.title.content, /挂车视频/);

  const done = await h.cardClick({ act: 'video_done', videoId: video.id });
  assert.equal(done.toast.type, 'success');
  const again = await h.cardClick({ act: 'video_done', videoId: video.id });
  assert.equal(again.toast.type, 'warning');
});

test('曝光视频不需要商品；非管理员不能操作', async () => {
  const h = createHarness({}, { noShop: true });
  await sendVideo(h, 'm-video-2');
  await h.app.idle();
  const video = h.store.listVideos()[0];
  const denied = await h.cardClick({ act: 'video_kind', videoId: video.id, kind: 'exposure' }, {}, 'ou_stranger');
  assert.equal(denied.toast.type, 'error');
  await h.cardClick({ act: 'video_kind', videoId: video.id, kind: 'exposure' }, {});
  await h.app.idle();
  const ready = h.store.video(video.id)!;
  assert.equal(ready.kind, 'exposure');
  assert.equal(ready.status, 'ready');
  assert.equal(ready.notes.some((n) => n.includes('手动挂车')), false);
});

test('桌面端添加本地视频并生成文案', async () => {
  const h = createHarness({}, { noShop: true });
  const dir = mkdtempSync(join(tmpdir(), 'video-src-'));
  const file = join(dir, 'clip.mp4');
  writeFileSync(file, Buffer.from('fake video'));
  const v = h.app.addLocalVideo(file);
  assert.equal(v.status, 'awaiting_info');
  const r = h.app.setVideoInfo(v.id, 'shoppable', '不存在的商品', '', LOCAL_OPERATOR);
  assert.equal(r.ok, true);
  await h.app.idle();
  const ready = h.store.video(v.id)!;
  assert.equal(ready.status, 'ready');
  assert.ok(ready.notes.some((n) => n.includes('手动挂车')));
});

test('桌面端提交链接走同一条取数队列', async () => {
  const h = createHarness({}, { noShop: true });
  assert.equal(h.app.submitLink('https://example.com/x').ok, false);
  const r = h.app.submitLink('https://detail.1688.com/offer/55.html');
  assert.equal(r.ok, true);
  const job = h.store.nextCapture();
  assert.equal(job?.url, 'https://detail.1688.com/offer/55.html');
});
