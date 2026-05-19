import { contextBridge, ipcRenderer } from "electron";

const INVOKE_CHANNELS = [
  "auth:status",
  "auth:connect",
  "auth:disconnect",
  "sync:start",
  "categories:list",
  "messages:list",
  "batch:preview",
  "batch:execute",
  "batch:undo",
  "actionlog:list",
  "rules:list",
  "rules:add",
  "rules:delete",
  "settings:get",
  "settings:set",
] as const;

const EVENT_CHANNELS = ["sync:progress"] as const;

contextBridge.exposeInMainWorld("electronAPI", {
  invoke: <T>(channel: string, ...args: unknown[]): Promise<T> => {
    if (!(INVOKE_CHANNELS as readonly string[]).includes(channel)) {
      throw new Error(`Unknown IPC channel: ${channel}`);
    }
    return ipcRenderer.invoke(channel, ...args) as Promise<T>;
  },
  on: (channel: string, listener: (...args: unknown[]) => void): (() => void) => {
    if (!(EVENT_CHANNELS as readonly string[]).includes(channel)) {
      throw new Error(`Unknown event channel: ${channel}`);
    }
    const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
      listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
