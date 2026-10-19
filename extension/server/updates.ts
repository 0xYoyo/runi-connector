// Self-updating for the Claude Desktop extension.
//
// Claude Desktop only auto-updates extensions from its official directory; a .mcpb installed by
// double-clicking never updates on its own. So the extension updates itself from the same npm
// package the ChatGPT / Codex / Claude Code install runs (`npx reichman-courses-connector`):
//
//   1. On start, if a verified newer version was downloaded earlier, run that instead.
//   2. After start, in the background, ask the npm registry for the latest version; if newer,
//      download the package, check it against the registry's sha512 integrity hash, and save
//      the server file. It takes effect the next time Claude starts the connector.
//
// A downloaded version that fails to start is marked bad and skipped, so a broken release
// can't lock anyone out. Set RUNI_NO_SELF_UPDATE=1 to turn it off.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { testOverride } from "../../src/test-mode";

export const PACKAGE = "reichman-courses-connector";
const registry = () => testOverride("RUNI_REGISTRY") ?? "https://registry.npmjs.org";
const SERVER_PATH_IN_PACKAGE = "package/dist/extension/server/index.js";

// "1.2.3" → compares numerically so 1.10.0 > 1.9.0.
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const appDir = (dataDir: string) => join(dataDir, "app");
const serverFile = (dataDir: string, v: string) => join(appDir(dataDir), `server-${v}.js`);
const startedMarker = (dataDir: string, v: string) => join(appDir(dataDir), `server-${v}.started`);
const okMarker = (dataDir: string, v: string) => join(appDir(dataDir), `server-${v}.ok`);
const badMarker = (dataDir: string, v: string) => join(appDir(dataDir), `server-${v}.bad`);

/** The newest downloaded version newer than `current` that hasn't failed, if any. */
export function pickDownloadedVersion(dataDir: string, current: string): { version: string; file: string } | null {
  if (!existsSync(appDir(dataDir))) return null;
  const versions = readdirSync(appDir(dataDir))
    .map((f) => f.match(/^server-(\d+\.\d+\.\d+)\.js$/)?.[1])
    .filter((v): v is string => Boolean(v) && compareVersions(v!, current) > 0)
    .sort(compareVersions)
    .reverse();
  for (const v of versions) {
    if (existsSync(badMarker(dataDir, v))) continue;
    // Only an explicit failure (markBad) rules a version out. "Started but not yet healthy" isn't
    // one: Claude Desktop starts several copies and closes the extras within a second, which
    // used to get perfectly good versions skipped.
    return { version: v, file: serverFile(dataDir, v) };
  }
  return null;
}

export function markStarting(dataDir: string, v: string) {
  if (!existsSync(okMarker(dataDir, v))) writeFileSync(startedMarker(dataDir, v), String(Date.now()), { mode: 0o600 });
}

/** Never use this downloaded version again (it failed to start or kept crashing). */
export function markBad(dataDir: string, v: string) {
  try {
    if (existsSync(appDir(dataDir))) writeFileSync(badMarker(dataDir, v), String(Date.now()), { mode: 0o600 });
  } catch {
    /* best effort */
  }
}

/** Called once a (downloaded) version is up and serving. */
export function markHealthy(dataDir: string, v: string) {
  if (existsSync(serverFile(dataDir, v))) writeFileSync(okMarker(dataDir, v), String(Date.now()), { mode: 0o600 });
}

// Minimal tar reader: returns the bytes of one file from an (uncompressed) tar archive.
export function extractFromTar(tar: Buffer, wanted: string): Buffer | null {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, len: number) => header.subarray(start, start + len).toString("utf8").replace(/\0.*$/s, "");
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const dataStart = offset + 512;
    if (fullName === wanted) return Buffer.from(tar.subarray(dataStart, dataStart + size));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal, headers: { "User-Agent": "reichman-courses-connector" } });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Downloads the latest published version if it's newer than `current`. Returns the version
 * saved, or null if already up to date. Never throws for network problems (returns null).
 */
export async function downloadLatest(dataDir: string, current: string, timeoutMs = 30_000): Promise<string | null> {
  try {
    const meta = await fetchWithTimeout(`${registry()}/${PACKAGE}/latest`, 8000);
    if (!meta.ok) return null;
    const { version, dist } = (await meta.json()) as { version?: string; dist?: { tarball?: string; integrity?: string } };
    if (!version || !VERSION_RE.test(version) || compareVersions(version, current) <= 0) return null;
    if (existsSync(serverFile(dataDir, version)) || existsSync(badMarker(dataDir, version))) return null;
    const integrity = dist?.integrity?.match(/^sha512-(.+)$/)?.[1];
    if (!dist?.tarball || !integrity) return null;
    if (new URL(dist.tarball).origin !== new URL(registry()).origin) return null; // only from the registry itself

    const res = await fetchWithTimeout(dist.tarball, timeoutMs);
    if (!res.ok) return null;
    const tgz = Buffer.from(await res.arrayBuffer());
    if (tgz.length > 20_000_000) throw new Error("package too large");
    if (createHash("sha512").update(tgz).digest("base64") !== integrity) throw new Error("integrity mismatch");
    const server = extractFromTar(gunzipSync(tgz), SERVER_PATH_IN_PACKAGE);
    if (!server || server.length < 1000) throw new Error("package has no server file");

    mkdirSync(appDir(dataDir), { recursive: true, mode: 0o700 });
    const tmp = serverFile(dataDir, version) + ".tmp";
    writeFileSync(tmp, server, { mode: 0o600 });
    renameSync(tmp, serverFile(dataDir, version));
    // Keep only the two newest downloads.
    const old = readdirSync(appDir(dataDir))
      .map((f) => f.match(/^server-(\d+\.\d+\.\d+)\.js$/)?.[1])
      .filter((v): v is string => Boolean(v))
      .sort(compareVersions)
      .reverse()
      .slice(2);
    for (const v of old) for (const f of [serverFile, startedMarker, okMarker, badMarker]) rmSync(f(dataDir, v), { force: true });
    return version;
  } catch (error) {
    if ((error as Error).message === "integrity mismatch" || (error as Error).message.startsWith("package ")) throw error;
    return null;
  }
}

/** The running version, baked in at build time. */
export function runningVersion(): string {
  try {
    return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}
declare const __APP_VERSION__: string | undefined;
