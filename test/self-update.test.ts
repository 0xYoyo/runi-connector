// The extension's self-update: download from an npm-style registry, verify sha512, run the
// newer version next start, and skip a version that fails to start.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server: Server;
let registry = "";
const packages: Record<string, { tgz: Buffer; integrity: string }> = {};
let latest = "9.9.9";

function makePackage(version: string, serverCode: string) {
  const dir = mkdtempSync(join(tmpdir(), "pkg-"));
  mkdirSync(join(dir, "package", "dist", "extension", "server"), { recursive: true });
  writeFileSync(join(dir, "package", "dist", "extension", "server", "index.js"), serverCode);
  writeFileSync(join(dir, "package", "package.json"), JSON.stringify({ name: "reichman-courses-connector", version }));
  const tgzPath = join(dir, "pkg.tgz");
  execFileSync("tar", ["-czf", tgzPath, "-C", dir, "package"]);
  const tgz = readFileSync(tgzPath);
  packages[version] = { tgz, integrity: "sha512-" + createHash("sha512").update(tgz).digest("base64") };
}

beforeAll(async () => {
  makePackage("9.9.9", "// v9.9.9 server\n" + "x".repeat(2000));
  makePackage("9.9.8", "// v9.9.8 server\n" + "y".repeat(2000));
  server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/reichman-courses-connector/latest") {
      const pkg = packages[latest];
      const integrity = url.searchParams.has("x") ? pkg.integrity : (globalThis as any).__tamper ? "sha512-AAAA" : pkg.integrity;
      res.end(JSON.stringify({ version: latest, dist: { tarball: `${registry}/tarballs/${latest}.tgz`, integrity } }));
      return;
    }
    const m = url.pathname.match(/^\/tarballs\/(.+)\.tgz$/);
    if (m && packages[m[1]]) return res.end(packages[m[1]].tgz);
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  registry = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.RUNI_REGISTRY = registry;
});
afterAll(() => {
  server.close();
  delete process.env.RUNI_REGISTRY;
});

const load = () => import("../extension/server/updates");

describe("self-update", () => {
  it("compares versions numerically", async () => {
    const { compareVersions } = await load();
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.1", "1.0.1")).toBe(0);
  });

  it("downloads a newer verified version and picks it next start", async () => {
    const { downloadLatest, pickDownloadedVersion } = await load();
    const data = mkdtempSync(join(tmpdir(), "data-"));
    expect(await downloadLatest(data, "1.0.1")).toBe("9.9.9");
    const pick = pickDownloadedVersion(data, "1.0.1");
    expect(pick?.version).toBe("9.9.9");
    expect(readFileSync(pick!.file, "utf8")).toContain("v9.9.9 server");
    // already have it / not newer → nothing to do
    expect(await downloadLatest(data, "1.0.1")).toBeNull();
    expect(await downloadLatest(mkdtempSync(join(tmpdir(), "d-")), "10.0.0")).toBeNull();
  });

  it("refuses a package whose hash doesn't match the registry", async () => {
    const { downloadLatest } = await load();
    const data = mkdtempSync(join(tmpdir(), "data-"));
    (globalThis as any).__tamper = true;
    await expect(downloadLatest(data, "1.0.1")).rejects.toThrow(/integrity/);
    (globalThis as any).__tamper = false;
    expect(existsSync(join(data, "app", "server-9.9.9.js"))).toBe(false);
  });

  it("skips a version marked bad, but not one that was merely started and closed", async () => {
    const { downloadLatest, pickDownloadedVersion, markStarting, markBad } = await load();
    const data = mkdtempSync(join(tmpdir(), "data-"));
    latest = "9.9.8";
    await downloadLatest(data, "1.0.1");
    latest = "9.9.9";
    await downloadLatest(data, "1.0.1");
    markStarting(data, "9.9.9"); // a copy started and was closed by the app: still fine
    expect(pickDownloadedVersion(data, "1.0.1")?.version).toBe("9.9.9");
    markBad(data, "9.9.9"); // it really failed
    expect(pickDownloadedVersion(data, "1.0.1")?.version).toBe("9.9.8");
  });

  it("is quiet when offline", async () => {
    process.env.RUNI_REGISTRY = "http://127.0.0.1:1";
    const { downloadLatest } = await load();
    expect(await downloadLatest(mkdtempSync(join(tmpdir(), "d-")), "1.0.0")).toBeNull();
    process.env.RUNI_REGISTRY = registry;
  });
});
