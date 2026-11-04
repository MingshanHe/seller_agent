// 配置和数据放在系统的应用数据目录，不放项目文件夹。
// 项目可能在 OneDrive 或网盘里：密钥不该被同步，SQLite 也不能放在同步盘上。
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export function dataDir(env: Record<string, string | undefined> = process.env, platform: string = process.platform): string {
  if (env.TTS_AGENT_HOME) return env.TTS_AGENT_HOME;
  if (platform === 'win32') {
    return win32.join(env.LOCALAPPDATA ?? win32.join(homedir(), 'AppData', 'Local'), 'tts-agent');
  }
  return posix.join(env.XDG_DATA_HOME ?? posix.join(homedir(), '.local', 'share'), 'tts-agent');
}
