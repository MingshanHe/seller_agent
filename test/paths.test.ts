import test from 'node:test';
import assert from 'node:assert/strict';
import { dataDir } from '../src/core/paths.ts';

test('Windows 上数据放在 LOCALAPPDATA，不放 OneDrive', () => {
  const dir = dataDir({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32');
  assert.equal(dir, 'C:\\Users\\a\\AppData\\Local\\tts-agent');
});

test('可以用环境变量指定位置', () => {
  assert.equal(dataDir({ TTS_AGENT_HOME: '/srv/agent' }, 'linux'), '/srv/agent');
});

test('Linux 默认放在用户数据目录', () => {
  assert.equal(dataDir({ XDG_DATA_HOME: '/data' }, 'linux'), '/data/tts-agent');
});
