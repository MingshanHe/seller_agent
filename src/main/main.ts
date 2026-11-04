// Electron 主进程：窗口、托盘、界面和引擎之间的 IPC。
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, clipboard, Tray } from 'electron';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_OPERATOR } from '../core/app.ts';
import { copyText } from '../core/listing/manual.ts';
import { postText } from '../core/video.ts';
import { assistVideoUpload, clearPartition, openAccountBrowser, openBrowser, SOURCE_PARTITION, URLS, accountPartition } from './browser.ts';
import { ensurePricing, loadConfig, maskedConfig, saveConfig, userDir, type DesktopConfig } from './config.ts';
import { initLogger, logFile, recentLogs } from './logger.ts';
import { Runtime } from './runtime.ts';

// 便携/测试用：指定数据目录。
if (process.env.SELLER_AGENT_HOME) app.setPath('userData', process.env.SELLER_AGENT_HOME);
if (!app.requestSingleInstanceLock()) app.quit();

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let runtime: Runtime | null = null;
let quitting = false;

function rendererPath(file: string) {
  return join(app.getAppPath(), 'renderer', file);
}

async function startRuntime() {
  if (runtime) await runtime.stop();
  runtime = null;
  try {
    runtime = new Runtime(loadConfig());
    runtime.start();
  } catch (err) {
    console.error('[runtime] 启动失败', err);
  }
}

const rt = () => {
  if (!runtime) throw new Error('引擎没有启动，请检查设置或查看日志');
  return runtime;
};

function accountOf(id?: string) {
  const cfg = rt().cfg;
  const a = cfg.accounts.find((x) => x.id === id) ?? cfg.accounts.find((x) => x.id === cfg.defaultAccountId) ?? cfg.accounts[0];
  if (!a) throw new Error('请先在「账号矩阵」里添加账号');
  return a;
}

function listImages(dir: string | null): string[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /\.(jpe?g|png|webp|gif)$/i.test(f)).sort().map((f) => join(dir, f));
}

function registerIpc() {
  const h = (ch: string, fn: (...args: any[]) => any) =>
    ipcMain.handle(ch, async (_e, ...args) => {
      try {
        return { ok: true, data: await fn(...args) };
      } catch (err) {
        return { ok: false, error: (err as Error).message ?? String(err) };
      }
    });

  h('status', () => ({ ...rt().status(), version: app.getVersion(), dataDir: userDir() }));

  // 配置
  h('config:get', () => maskedConfig(loadConfig()));
  h('config:save', async (cfg: DesktopConfig) => { saveConfig(cfg); await startRuntime(); return true; });
  h('pricing:get', () => readFileSync(ensurePricing(), 'utf8'));
  h('pricing:save', async (text: string) => {
    JSON.parse(text); // 格式不对时直接报错，不写盘
    writeFileSync(ensurePricing(), text);
    await startRuntime();
    return true;
  });

  // 上架
  h('link:submit', (url: string, accountId?: string) => rt().app.submitLink(url.trim(), accountId));
  h('captures:list', () => rt().store.recentCaptures(30));
  h('drafts:list', () => rt().store.listDrafts(200).map((d) => ({ ...d, images: d.images, localImages: listImages(d.packageDir) })));
  h('draft:action', (act: 'manual_reprice' | 'manual_done' | 'manual_reject', id: string, price?: number) => rt().app.desktopManualAction(act, id, price));
  h('draft:copy', (id: string, what: 'all' | 'title' | 'desc' | 'skus') => {
    const d = rt().store.draft(id);
    if (!d) throw new Error('草稿不存在');
    const text = what === 'title' ? d.content.title
      : what === 'desc' ? d.content.descriptionParagraphs.join('\n')
      : what === 'skus' ? d.skus.map((s) => `${s.sellerSku}\t${s.specs.map((x) => x.value).join(' / ') || '单规格'}\t${s.priceJpy}\t${s.stock}`).join('\n')
      : copyText(d);
    clipboard.writeText(text);
    return true;
  });
  h('draft:openPackage', (id: string) => {
    const d = rt().store.draft(id);
    if (!d?.packageDir) throw new Error('这个草稿没有资料包');
    return shell.openPath(d.packageDir);
  });
  h('draft:openSeller', (id: string) => {
    const d = rt().store.draft(id);
    openAccountBrowser(accountOf(d?.accountId), 'seller');
    if (d) clipboard.writeText(d.content.title);
    return true;
  });

  // 视频
  h('videos:list', () => rt().store.listVideos(200).map((v) => ({ ...v, postText: postText(v) })));
  h('video:add', async (accountId?: string) => {
    const r = await dialog.showOpenDialog(win!, {
      title: '选择视频', properties: ['openFile', 'multiSelections'],
      filters: [{ name: '视频', extensions: ['mp4', 'mov', 'm4v', 'webm'] }],
    });
    if (r.canceled) return [];
    return r.filePaths.map((p) => rt().app.addLocalVideo(p, accountId));
  });
  h('video:cover', async (id: string) => {
    const r = await dialog.showOpenDialog(win!, { title: '选择封面图（可选，帮助 Claude 理解视频内容）', properties: ['openFile'], filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
    if (r.canceled) return false;
    const v = rt().store.video(id);
    if (!v) throw new Error('视频不存在');
    const target = v.filePath.replace(/\.[^.]+$/, `-cover${r.filePaths[0].match(/\.[^.]+$/)?.[0] ?? '.jpg'}`);
    writeFileSync(target, readFileSync(r.filePaths[0]));
    rt().store.updateVideo(id, { coverPath: target });
    return true;
  });
  h('video:setInfo', (id: string, kind: 'shoppable' | 'exposure', product: string, hint: string, accountId?: string) =>
    rt().app.setVideoInfo(id, kind, product, hint, LOCAL_OPERATOR, accountId));
  h('video:edit', (id: string, caption: string, hashtags: string[]) => { rt().app.editVideoCaption(id, caption, hashtags); return true; });
  h('video:assist', (id: string) => {
    const v = rt().store.video(id);
    if (!v) throw new Error('视频不存在');
    return assistVideoUpload(accountOf(v.accountId), v.filePath, postText(v));
  });
  h('video:done', (id: string) => rt().app.markVideoPublished(id, LOCAL_OPERATOR));
  h('video:reject', (id: string) => rt().app.rejectVideo(id));
  h('video:show', (id: string) => { const v = rt().store.video(id); if (v) shell.showItemInFolder(v.filePath); return true; });
  h('copy', (text: string) => { clipboard.writeText(text); return true; });

  // 订单和货源
  h('tasks:list', () => rt().store.listTasks(200));
  h('lookup', (q: string) => {
    const store = rt().store;
    const query = q.trim();
    for (const shopId of ['manual', ...store.shops().map((s) => s.id)]) {
      const m = store.skuMapping(shopId, query);
      if (m) {
        const d = store.draft(m.draftId);
        return [{ title: d?.content.title ?? d?.source.title ?? '', sourceTitle: d?.source.title ?? '', sku: m.sellerSku, spec: m.specText, cost: m.purchaseCny, url: m.sourceUrl }];
      }
    }
    return store.searchDrafts(query, 10).map((d) => ({
      title: d.content.title, sourceTitle: d.source.title, sku: d.skus.map((s) => s.sellerSku).join('、'), spec: '', cost: d.skus[0]?.purchaseCny ?? 0, url: d.source.url,
    }));
  });

  // 浏览器
  h('browser:source', (url?: string) => {
    openBrowser({
      key: 'source', partition: SOURCE_PARTITION, url: url || URLS.login1688, title: '货源浏览器（1688 / 淘宝）',
      onCapture: (capture) => rt().app.completeCapture({ status: 'ok', capture }),
    });
    return true;
  });
  h('browser:account', (accountId: string, target: 'seller' | 'studio' | 'tiktok') => { openAccountBrowser(accountOf(accountId), target); return true; });
  h('browser:clear', async (accountId: string | null) => { await clearPartition(accountId ? accountPartition(accountId) : SOURCE_PARTITION); return true; });
  h('open:external', (url: string) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return true; });
  h('open:path', (p: string) => shell.openPath(p));
  h('open:dataDir', () => shell.openPath(userDir()));
  h('open:log', () => shell.openPath(logFile()));

  // 诊断
  h('logs', () => recentLogs(400));
  h('audit', () => rt().store.recentAudit(200));
  h('test:claude', async () => {
    const r = await rt().claude.structured<{ ok: string }>({
      system: '用 JSON 回复，ok 字段填 "はい"。',
      content: [{ type: 'text', text: 'ping' }],
      schema: { type: 'object', properties: { ok: { type: 'string' } }, required: ['ok'], additionalProperties: false },
      maxTokens: 50,
    });
    return `Claude 正常：${r.ok}`;
  });
  h('test:feishu', async () => {
    const chat = rt().cfg.feishu.opsChatId;
    if (!chat) throw new Error('还没填运营群 chat_id。先在飞书给机器人发“id”，它会回复。');
    await rt().feishu.sendText(chat, 'Seller Agent 测试消息：飞书连接正常。');
    return '已发送测试消息到运营群';
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'Seller Agent',
    backgroundColor: '#0f1115',
    show: false,
    webPreferences: { preload: join(app.getAppPath(), 'dist', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenu(null);
  win.loadFile(rendererPath('index.html'));
  win.once('ready-to-show', () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('close', (e) => {
    // 关窗口时最小化到托盘，保持飞书长连接和取数在后台运行。
    if (!quitting && runtime?.cfg.ui.minimizeToTray) {
      e.preventDefault();
      win?.hide();
    }
  });
}

function createTray() {
  const iconFile = join(app.getAppPath(), 'build', 'icon.png');
  const icon = existsSync(iconFile) ? nativeImage.createFromPath(iconFile).resize({ width: 16, height: 16 }) : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Seller Agent：后台运行中');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主界面', click: () => { win?.show(); win?.focus(); } },
    { label: '货源浏览器', click: () => openBrowser({ key: 'source', partition: SOURCE_PARTITION, url: URLS.login1688, title: '货源浏览器（1688 / 淘宝）', onCapture: (c) => runtime?.app.completeCapture({ status: 'ok', capture: c }) }) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => { win?.show(); win?.focus(); });
}

app.on('second-instance', () => { win?.show(); win?.focus(); });

app.whenReady().then(async () => {
  app.setAppUserModelId('com.mingshanhe.selleragent');
  initLogger(join(userDir(), 'logs'));
  console.log(`[app] Seller Agent ${app.getVersion()} 启动，数据目录 ${userDir()}`);
  registerIpc();
  await startRuntime();
  createWindow();
  createTray();
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => {
  if (!runtime?.cfg.ui.minimizeToTray) app.quit();
});
app.on('will-quit', async (e) => {
  if (runtime) {
    e.preventDefault();
    const r = runtime;
    runtime = null;
    await r.stop().catch(() => {});
    app.exit(0);
  }
});
