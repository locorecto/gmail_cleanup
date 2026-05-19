import { useCallback, useEffect } from "react";
import type { SyncProgress } from "@shared/types";

declare global {
  interface Window {
    electronAPI: {
      invoke: <T>(channel: string, ...args: unknown[]) => Promise<T>;
      on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
    };
  }
}

export function useInvoke() {
  return useCallback(
    <T>(channel: string, ...args: unknown[]): Promise<T> =>
      window.electronAPI.invoke<T>(channel, ...args),
    []
  );
}

export function useSyncProgress(onProgress: (p: SyncProgress) => void): void {
  useEffect(() => {
    const unsub = window.electronAPI.on("sync:progress", (p) =>
      onProgress(p as SyncProgress)
    );
    return unsub;
  }, [onProgress]);
}
