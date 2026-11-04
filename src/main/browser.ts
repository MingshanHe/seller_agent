// 内置浏览器：
// 1. 货源取数：替代原来的 Chrome 插件。用独立的登录会话打开 1688/淘宝页面，只读取页面内容。
// 2. 账号窗口：每个 TikTok 账号一个独立会话（cookie 互不影响），用来登录卖家中心和 TikTok Studio，做账号矩阵。
// 3. 辅助发视频：打开 TikTok Studio，把视频放进上传框、文案复制到剪贴板，最后由你确认并点发布。
import { BrowserWindow, Menu, clipboard, session, shell, type Session } from 'electron';
import type { RawCapture } from '../core/listing/llm.ts';
import type { Account } from '../core/types.ts';

export const SOURCE_PARTITION = 'persist:source';
export const accountPartition = (id: string) => `persist:acct-${id.replace(/[^\w-]/g, '_')}`;

export const URLS = {
  login1688: 'https://login.1688.com/',
  taobao: 'https://login.taobao.com/',
  sellerJp: 'https://seller-jp.tiktok.com/',
  studioUpload: 'https://www.tiktok.com/tiktokstudio/upload',
  tiktok: 'https://www.tiktok.com/',
};

/** 去掉 UA 里的 Electron 标记，看起来和普通 Chrome 一样。 */
function cleanSession(s: Session): Session {
  const ua = s.getUserAgent().replace(/\s?Electron\/\S+/i, '').replace(/\s?seller-agent\/\S+/i, '').replace(/\s?Seller Agent\/\S+/i, '');
  s.setUserAgent(ua);
  return s;
}

/** 注入页面的取数函数。不点击、不提交、不处理验证码。整个函数会被序列化，不能引用外部变量。 */
function extractPage() {
  const url = location.href;
  const head = (document.body?.innerText ?? '').slice(0, 3000);
  const blockedUrl = /captcha|punish|login\.|passport\.|\/login/i.test(url);
  const blockedText = /验证码|滑动验证|按住滑块|安全验证|请登录后|访问受限/.test(head);
  if (blockedUrl || blockedText) return { blocked: true, url };

  const images = new Set<string>();
  for (const img of Array.from(document.images)) {
    const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
    if (!/^https:/.test(src)) continue;
    if (img.naturalWidth > 0 && img.naturalWidth < 300) continue;
    // 阿里 CDN 的缩略图形如 a.jpg_310x310.jpg，去掉后缀就是原图。
    images.add(src.replace(/(\.(?:jpe?g|png|webp))_[^/]*$/i, '$1'));
  }
  const structured = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
    .map((s) => s.textContent)
    .join('\n')
    .slice(0, 20000);
  return {
    blocked: false,
    url,
    title: document.title,
    text: (document.body?.innerText ?? '').slice(0, 60000),
    images: [...images].slice(0, 60),
    structured,
  };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadWithTimeout(win: BrowserWindow, url: string, ms: number) {
  await Promise.race([
    win.loadURL(url).catch((e) => {
      // 有些页面会中途重定向，ERR_ABORTED 不影响读取。
      if (!String(e?.message ?? e).includes('ERR_ABORTED')) throw e;
    }),
    pause(ms),
  ]);
}

export async function readPage(win: BrowserWindow): Promise<{ blocked: true; url: string } | ({ blocked: false } & RawCapture)> {
  // 分几次滚动，让懒加载的详情图出来。
  for (let i = 1; i <= 4; i++) {
    await win.webContents.executeJavaScript(`window.scrollTo({ top: document.body.scrollHeight * ${i / 4} })`, true).catch(() => {});
    await pause(700);
  }
  await pause(1200);
  return win.webContents.executeJavaScript(`(${extractPage.toString()})()`, true);
}

export interface CaptureJob { id: string; url: string }

/** 取数队列的执行者：每 3 秒看一次有没有新链接，一次只开一个页面。 */
export class CaptureWorker {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private history: number[] = [];
  lastError = '';
  current: string | null = null;

  private o: {
    next: () => CaptureJob | null;
    complete: (body: { jobId?: string; status: 'ok' | 'blocked' | 'error'; message?: string; capture?: RawCapture }) => void;
    hourlyLimit: () => number;
    showWindow: () => boolean;
  };

  constructor(o: CaptureWorker['o']) {
    this.o = o;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch((e) => console.error('[capture]', e)); }, 3000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick() {
    if (this.busy) return;
    const job = this.o.next();
    if (!job) return;
    this.busy = true;
    this.current = job.url;
    try {
      this.history = this.history.filter((t) => Date.now() - t < 3600_000);
      if (this.history.length >= this.o.hourlyLimit()) {
        this.o.complete({ jobId: job.id, status: 'error', message: '已到每小时取数上限，请稍后再发（可在设置里调整）' });
        return;
      }
      this.history.push(Date.now());
      await this.capture(job);
    } finally {
      this.busy = false;
      this.current = null;
    }
  }

  private async capture(job: CaptureJob) {
    const win = new BrowserWindow({
      show: this.o.showWindow(),
      width: 1280,
      height: 900,
      title: `取数中：${job.url}`,
      webPreferences: { session: cleanSession(session.fromPartition(SOURCE_PARTITION)), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.webContents.setAudioMuted(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    try {
      await loadWithTimeout(win, job.url, 30_000);
      await pause(1500);
      const page = await readPage(win);
      if (page.blocked) {
        this.o.complete({ jobId: job.id, status: 'blocked' });
        return;
      }
      const { blocked: _b, ...capture } = page;
      // 商品下架或需要登录时，货源站常把商品页跳到首页。读到的是首页就不能当商品用。
      const offerId = /(\d{6,})/.exec(new URL(job.url).pathname + new URL(job.url).search)?.[1];
      if (offerId && !capture.url.includes(offerId)) {
        this.o.complete({ jobId: job.id, status: 'error', message: `页面被跳转到 ${capture.url}，商品可能已下架，或需要先在货源浏览器登录` });
        return;
      }
      console.log(`[capture] 已读取 ${capture.url}，图片 ${capture.images.length} 张`);
      this.o.complete({ jobId: job.id, status: 'ok', capture });
    } catch (err) {
      this.lastError = String((err as Error)?.message ?? err);
      this.o.complete({ jobId: job.id, status: 'error', message: this.lastError });
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }
}

const windows = new Map<string, BrowserWindow>();

/**
 * 打开一个可见的浏览器窗口。同一个会话+用途只开一个窗口。
 * onCapture：在货源窗口的菜单里“把当前页上架”。
 */
export function openBrowser(opts: {
  key: string;
  partition: string;
  url: string;
  title: string;
  onCapture?: (capture: RawCapture) => void;
}): BrowserWindow {
  const existing = windows.get(opts.key);
  if (existing && !existing.isDestroyed()) {
    existing.loadURL(opts.url).catch(() => {});
    existing.show();
    existing.focus();
    return existing;
  }
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    title: opts.title,
    autoHideMenuBar: false,
    webPreferences: { session: cleanSession(session.fromPartition(opts.partition)), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  // 新窗口在同一个窗口里打开，保持同一个登录会话。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) win.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
  win.on('page-title-updated', (e, t) => { e.preventDefault(); win.setTitle(`${opts.title} — ${t}`); });

  const menu: Electron.MenuItemConstructorOptions[] = [
    { label: '← 后退', click: () => win.webContents.navigationHistory.canGoBack() && win.webContents.navigationHistory.goBack() },
    { label: '前进 →', click: () => win.webContents.navigationHistory.canGoForward() && win.webContents.navigationHistory.goForward() },
    { label: '刷新', accelerator: 'F5', click: () => win.webContents.reload() },
    { label: '复制当前网址', click: () => clipboard.writeText(win.webContents.getURL()) },
    { label: '用系统浏览器打开', click: () => shell.openExternal(win.webContents.getURL()) },
  ];
  if (opts.onCapture) {
    menu.unshift({
      label: '★ 把当前页上架',
      click: async () => {
        const page = await readPage(win);
        if (page.blocked) {
          win.setTitle(`${opts.title} — 当前页需要登录或验证，请先处理`);
          return;
        }
        const { blocked: _b, ...capture } = page;
        opts.onCapture!(capture);
        win.setTitle(`${opts.title} — 已发送：${capture.title}`);
      },
    });
  }
  win.setMenu(Menu.buildFromTemplate(menu));
  win.loadURL(opts.url).catch(() => {});
  win.on('closed', () => windows.delete(opts.key));
  windows.set(opts.key, win);
  return win;
}

export function openAccountBrowser(account: Account, target: 'seller' | 'studio' | 'tiktok', url?: string): BrowserWindow {
  const dest = url ?? (target === 'seller' ? URLS.sellerJp : target === 'studio' ? URLS.studioUpload : URLS.tiktok);
  const label = target === 'seller' ? '卖家中心' : target === 'studio' ? 'TikTok Studio' : 'TikTok';
  return openBrowser({ key: `${account.id}:${target}`, partition: accountPartition(account.id), url: dest, title: `${account.name} · ${label}` });
}

/**
 * 辅助发视频：打开账号的 TikTok Studio 上传页，把视频文件放进上传框，文案复制到剪贴板。
 * 不会点“发布”按钮，最后一步由人确认。
 */
export async function assistVideoUpload(account: Account, filePath: string, text: string): Promise<{ ok: boolean; message: string }> {
  clipboard.writeText(text);
  const win = openAccountBrowser(account, 'studio');
  // 等上传框出现，最多 40 秒（可能需要先登录）。
  let found = false;
  for (let i = 0; i < 40 && !win.isDestroyed(); i++) {
    await pause(1000);
    found = await win.webContents.executeJavaScript(`!!document.querySelector('input[type=file]')`, true).catch(() => false);
    if (found) break;
  }
  if (win.isDestroyed()) return { ok: false, message: '窗口已关闭' };
  if (!found) {
    shell.showItemInFolder(filePath);
    return { ok: false, message: '没有找到上传框（可能还没登录）。文案已复制，视频所在文件夹已打开，请拖进上传区域。' };
  }
  const dbg = win.webContents.debugger;
  try {
    if (!dbg.isAttached()) dbg.attach('1.3');
    const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
    if (!nodeId) throw new Error('上传框不可用');
    await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files: [filePath] });
    return { ok: true, message: '视频已放入上传框，文案已复制。等上传完成后，点描述框按 Ctrl+V 粘贴；挂车视频请点“添加链接 → 商品”选择商品，确认后再点发布。' };
  } catch (err) {
    shell.showItemInFolder(filePath);
    return { ok: false, message: `自动放入视频失败：${(err as Error).message}。文案已复制，请手动拖入视频。` };
  } finally {
    try { dbg.detach(); } catch { /* ignore */ }
  }
}

export async function clearPartition(partition: string) {
  await session.fromPartition(partition).clearStorageData();
}
