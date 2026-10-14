// A tiny file-backed stand-in for the Cloudflare KV namespace, for the local version.
// Stores everything in one JSON file under ~/.runi-connector/ with owner-only permissions.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DATA_DIR = process.env.RUNI_CONNECTOR_DIR ?? join(homedir(), ".runi-connector");

export function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

export function writePrivateFile(name: string, contents: string) {
  ensureDataDir();
  const path = join(DATA_DIR, name);
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function readPrivateFile(name: string): string | null {
  const path = join(DATA_DIR, name);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export class FileKV {
  private data: Record<string, string>;

  constructor(private readonly fileName = "cache.json") {
    const raw = readPrivateFile(fileName);
    this.data = raw ? JSON.parse(raw) : {};
  }

  async get(key: string, type?: "text" | "json"): Promise<any> {
    const value = this.data[key];
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key: string, value: string): Promise<void> {
    this.data[key] = value;
    writePrivateFile(this.fileName, JSON.stringify(this.data));
  }
}
