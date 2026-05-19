import { app, BrowserWindow, nativeTheme } from "electron";
import * as path from "path";
import { registerIpcHandlers, restoreSession, setMainWindow } from "./ipc/handlers";
import { pruneOldBackups } from "./backup/jsonl";

const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Gmail Cleanup",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, "../../dist/index.html"));
  }

  return win;
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = "system";

  registerIpcHandlers();

  const win = createWindow();
  setMainWindow(win);

  await restoreSession().catch(console.error);

  pruneOldBackups(90);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const newWin = createWindow();
      setMainWindow(newWin);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
