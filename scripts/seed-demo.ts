// 用模拟平台往一个独立的数据目录里写几条商品和视频，方便不填密钥也能看界面效果。
// 用法：node scripts/seed-demo.ts <数据目录>，然后 SELLER_AGENT_HOME=<数据目录> npm start
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHarness } from './harness.ts';
import { LOCAL_OPERATOR } from '../src/core/app.ts';

const home = process.argv[2];
if (!home) throw new Error('用法：node scripts/seed-demo.ts <数据目录>');
mkdirSync(join(home, 'data'), { recursive: true });

const h = createHarness(
  { marketPrices: [1800, 2000, 2200, 2400, 2600, 2800, 3000] },
  { noShop: true, dbPath: join(home, 'data', 'agent.sqlite'), packageDir: join(home, 'tts-listings') },
);
await h.linkAndCapture('https://detail.1688.com/offer/111111.html');
await h.linkAndCapture('https://detail.1688.com/offer/222222.html');
const [d1] = h.store.listDrafts();
await h.cardClick({ act: 'manual_done', draftId: d1.id });

const clip = join(home, 'clip.mp4');
writeFileSync(clip, Buffer.from('not a real video'));
const v1 = h.app.addLocalVideo(clip);
h.app.setVideoInfo(v1.id, 'shoppable', d1.skus[0].sellerSku, '夏のアウトドア', LOCAL_OPERATOR);
h.app.addLocalVideo(clip);
await h.app.idle();
h.store.close();
console.log('已写入演示数据：', home);
