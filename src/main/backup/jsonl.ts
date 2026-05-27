import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import type { DbMessage } from "../../shared/types";

function backupDir(): string {
  const dir = path.join(app.getPath("userData"), "backups");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function writeBackup(
  accountEmail: string,
  logId: number,
  messages: DbMessage[]
): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${ts}_log${logId}.jsonl`;
  const filepath = path.join(backupDir(), filename);

  const lines = messages
    .map((m) => JSON.stringify({ account: accountEmail, ...m }))
    .join("\n");

  await fs.promises.writeFile(filepath, lines, "utf-8");
  return filepath;
}

export function pruneOldBackups(maxAgeDays = 90): void {
  const dir = backupDir();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const file of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(fullPath);
    }
  }
}
