// 界面只能通过这里调用主进程，拿不到 Node 和 Electron 的其他能力。
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('agent', {
  call: async (channel: string, ...args: unknown[]) => {
    const r = await ipcRenderer.invoke(channel, ...args);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  },
});
