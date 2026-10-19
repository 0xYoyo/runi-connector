// Versions. There are no automatic updates: a new version is installed only when the student
// chooses to (double-clicking a new .mcpb, or re-running the install command). Earlier versions
// (1.4–1.6) updated themselves from npm; their downloaded copies are removed here.

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";

declare const __APP_VERSION__: string | undefined;

export function runningVersion(): string {
  try {
    return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

/** Deletes what the old self-updating versions downloaded (never the install copy for ChatGPT/terminal). */
export function removeOldDownloads(dataDir: string) {
  const app = join(dataDir, "app");
  try {
    for (const name of readdirSync(app)) {
      if (/^server-\d+\.\d+\.\d+\.(js|ok|bad|started|tmp)$/.test(name)) rmSync(join(app, name), { force: true });
    }
  } catch {
    /* no app folder */
  }
  rmSync(join(dataDir, "launcher-status.json"), { force: true });
}
