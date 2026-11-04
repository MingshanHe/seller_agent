// 桌面端配置：存在 %APPDATA%\Seller Agent\config.json。密钥用 Windows DPAPI（safeStorage）加密。
import { app, safeStorage } from 'electron';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Account } from '../core/types.ts';

export interface DesktopConfig {
  claude: { apiKey: string; model: string };
  feishu: { appId: string; appSecret: string; adminOpenIds: string; opsChatId: string };
  dashscope: { apiKey: string; baseUrl: string; model: string };
  market: { rakutenAppId: string; rakutenAccessKey: string; yahooAppId: string };
  fx: { cnyJpy: string; usdJpy: string };
  tiktok: { appKey: string; appSecret: string; serviceId: string; port: number };
  paths: { packageDir: string; videoDir: string };
  accounts: Account[];
  defaultAccountId: string;
  capture: { hourlyLimit: number; showWindow: boolean };
  ui: { minimizeToTray: boolean };
}

/** 这些字段写盘时加密，读给界面时打码。 */
export const SECRET_FIELDS: [keyof DesktopConfig, string][] = [
  ['claude', 'apiKey'], ['feishu', 'appSecret'], ['dashscope', 'apiKey'],
  ['market', 'rakutenAccessKey'], ['tiktok', 'appSecret'],
];
export const MASK = '********';

export function defaults(): DesktopConfig {
  return {
    claude: { apiKey: '', model: 'claude-sonnet-5-5' },
    feishu: { appId: '', appSecret: '', adminOpenIds: '', opsChatId: '' },
    dashscope: { apiKey: '', baseUrl: '', model: 'qwen-mt-image-2.0' },
    market: { rakutenAppId: '', rakutenAccessKey: '', yahooAppId: '' },
    fx: { cnyJpy: '', usdJpy: '' },
    tiktok: { appKey: '', appSecret: '', serviceId: '', port: 8787 },
    paths: {
      packageDir: join(homedir(), 'Downloads', 'tts-listings'),
      videoDir: join(homedir(), 'Downloads', 'tts-videos'),
    },
    accounts: [{ id: 'acct-1', name: '日本店1号', type: 'shop', note: '测试账号' }],
    defaultAccountId: 'acct-1',
    capture: { hourlyLimit: 30, showWindow: false },
    ui: { minimizeToTray: true },
  };
}

export const userDir = () => app.getPath('userData');
const configPath = () => join(userDir(), 'config.json');
export const dataPath = () => join(userDir(), 'data', 'agent.sqlite');
export const pricingPath = () => join(userDir(), 'pricing.jp.json');

function encrypt(v: string): string {
  if (!v) return '';
  if (!safeStorage.isEncryptionAvailable()) return v;
  return `enc:${safeStorage.encryptString(v).toString('base64')}`;
}

function decrypt(v: string): string {
  if (!v || !v.startsWith('enc:')) return v ?? '';
  try {
    return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
  } catch {
    return '';
  }
}

function merge<T extends object>(base: T, over: any): T {
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  if (!over || typeof over !== 'object') return out;
  for (const [k, v] of Object.entries(over)) {
    const b = (base as any)[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object' && !Array.isArray(v) ? merge(b, v) : v;
  }
  return out;
}

export function loadConfig(): DesktopConfig {
  let raw: any = {};
  if (existsSync(configPath())) {
    try { raw = JSON.parse(readFileSync(configPath(), 'utf8')); } catch { raw = {}; }
  }
  const cfg = merge(defaults(), raw);
  for (const [sec, key] of SECRET_FIELDS) (cfg[sec] as any)[key] = decrypt((cfg[sec] as any)[key]);
  if (!Array.isArray(cfg.accounts) || cfg.accounts.length === 0) cfg.accounts = defaults().accounts;
  return cfg;
}

export function saveConfig(next: DesktopConfig) {
  const current = loadConfig();
  const out: any = JSON.parse(JSON.stringify(next));
  for (const [sec, key] of SECRET_FIELDS) {
    // 界面上没改的密钥显示为打码，保存时沿用旧值。
    const v = out[sec]?.[key];
    out[sec][key] = encrypt(v === MASK ? (current[sec] as any)[key] : v ?? '');
  }
  mkdirSync(userDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(out, null, 2));
}

/** 给界面的版本：密钥打码。 */
export function maskedConfig(cfg: DesktopConfig): DesktopConfig {
  const out: any = JSON.parse(JSON.stringify(cfg));
  for (const [sec, key] of SECRET_FIELDS) if (out[sec][key]) out[sec][key] = MASK;
  return out;
}

/** 第一次运行时把默认定价参数复制到用户目录，之后在界面里改。 */
export function ensurePricing(): string {
  const target = pricingPath();
  if (!existsSync(target)) {
    mkdirSync(userDir(), { recursive: true });
    const candidates = [
      join(process.resourcesPath ?? '', 'config', 'pricing.jp.json'),
      join(app.getAppPath(), 'config', 'pricing.jp.json'),
    ];
    const src = candidates.find((p) => existsSync(p));
    if (!src) throw new Error('找不到默认定价参数 pricing.jp.json');
    copyFileSync(src, target);
  }
  return target;
}
