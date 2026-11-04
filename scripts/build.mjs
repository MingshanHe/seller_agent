// 用 esbuild 把主进程和 preload 打成两个 CommonJS 文件。界面是纯 HTML/JS，不需要打包。
import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  external: ['electron', '@larksuiteoapi/node-sdk'],
};

await build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.cjs' });
await build({ ...common, entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.cjs' });
