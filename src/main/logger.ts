// 把主进程的 console 输出收进内存（给界面看）并写到日志文件。
import { appendFileSync, mkdirSync, statSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';

export interface LogLine { at: number; level: 'info' | 'warn' | 'error'; text: string }

const buffer: LogLine[] = [];
const MAX = 1000;
let file = '';

export function initLogger(dir: string) {
  mkdirSync(dir, { recursive: true });
  file = join(dir, 'app.log');
  // 超过 5 MB 就轮换一次。
  try {
    if (existsSync(file) && statSync(file).size > 5 * 1024 * 1024) renameSync(file, `${file}.1`);
  } catch { /* ignore */ }
  const wrap = (level: LogLine['level'], orig: (...a: any[]) => void) => (...args: any[]) => {
    const text = format(...args);
    push(level, text);
    try { orig(...args); } catch { /* 没有控制台时忽略 */ }
  };
  console.log = wrap('info', console.log.bind(console));
  console.info = wrap('info', console.info.bind(console));
  console.warn = wrap('warn', console.warn.bind(console));
  console.error = wrap('error', console.error.bind(console));
}

export function push(level: LogLine['level'], text: string) {
  const line = { at: Date.now(), level, text };
  buffer.push(line);
  if (buffer.length > MAX) buffer.shift();
  if (file) {
    try { appendFileSync(file, `${new Date(line.at).toISOString()} [${level}] ${text}\n`); } catch { /* ignore */ }
  }
}

export function recentLogs(limit = 300): LogLine[] {
  return buffer.slice(-limit);
}

export const logFile = () => file;
