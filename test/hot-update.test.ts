// Updates while running, no restart: the launcher swaps in a newer version mid-session, keeps the
// session working, and refuses a broken release.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMockReichman, VALID_USER } from "./mock-reichman";

const BUNDLE = join(process.cwd(), "dist", "extension", "server", "index.js");
const run = existsSync(BUNDLE) ? describe : describe.skip;
const VERSION = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version as string;

// Packs a copy of the built connector as if it were version `v` (optionally broken).
function pack(v: string, broken = false) {
  const dir = mkdtempSync(join(tmpdir(), "pkg-"));
  mkdirSync(join(dir, "package", "dist", "extension", "server"), { recursive: true });
  let code = readFileSync(BUNDLE, "utf8").split(JSON.stringify(VERSION)).join(JSON.stringify(v));
  if (broken) code = code.replace("#!/usr/bin/env node", "#!/usr/bin/env node\nprocess.exit(3);");
  writeFileSync(join(dir, "package", "dist", "extension", "server", "index.js"), code);
  writeFileSync(join(dir, "package", "package.json"), JSON.stringify({ name: "reichman-courses-connector", version: v }));
  execFileSync("tar", ["-czf", join(dir, "p.tgz"), "-C", dir, "package"]);
  const tgz = readFileSync(join(dir, "p.tgz"));
  return { tgz, integrity: "sha512-" + createHash("sha512").update(tgz).digest("base64") };
}

let registry: Server;
let registryUrl = "";
let published: { version: string; tgz: Buffer; integrity: string } | null = null;
let mock: { server: Server; base: string };
let client: Client;
let dataDir: string;
const text = (r: any) => r.content.map((c: any) => c.text).join("\n");
const status = async () => text(await client.callTool({ name: "connector_status", arguments: {} }));

beforeAll(async () => {
  if (!existsSync(BUNDLE)) return;
  registry = createServer((req, res) => {
    if (req.url === "/reichman-courses-connector/latest" && published) {
      return res.end(JSON.stringify({ version: published.version, dist: { tarball: `${registryUrl}/t/${published.version}.tgz`, integrity: published.integrity } }));
    }
    if (published && req.url === `/t/${published.version}.tgz`) return res.end(published.tgz);
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => registry.listen(0, "127.0.0.1", r));
  registryUrl = `http://127.0.0.1:${(registry.address() as any).port}`;
  mock = await startMockReichman();
  dataDir = mkdtempSync(join(tmpdir(), "runi-hot-"));
  writeFileSync(join(dataDir, "credentials.hex"), Buffer.from(JSON.stringify({ reichman: VALID_USER })).toString("hex"), { mode: 0o600 });
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: [BUNDLE],
      env: {
        ...process.env,
        RUNI_TEST_MODE: "1",
        RUNI_DATA_DIR: dataDir,
        RUNI_SETUP_PORT: "0",
        RUNI_NO_BROWSER: "1",
        RUNI_CREDENTIALS_BACKEND: "file",
        RUNI_REGISTRY: registryUrl,
        RUNI_UPDATE_INTERVAL_MS: "400",
        MOODLE_BASE: `${mock.base}/moodle`,
      } as Record<string, string>,
    }),
  );
}, 30_000);

afterAll(async () => {
  await client?.close();
  mock?.server.close();
  registry?.close();
});

async function waitFor(check: () => Promise<boolean>, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

run("updates without restarting", () => {
  it("starts on the built-in version", async () => {
    expect(await status()).toContain(`Connector version: ${VERSION}`);
    expect(text(await client.callTool({ name: "list_courses", arguments: {} }))).toContain("course no. 77");
  });

  it("switches to a newly published version mid-session, and keeps working", async () => {
    published = { version: "9.9.9", ...pack("9.9.9") };
    expect(await waitFor(async () => (await status()).includes("Connector version: 9.9.9"))).toBe(true);
    expect(text(await client.callTool({ name: "list_courses", arguments: {} }))).toContain("course no. 77");
    expect(existsSync(join(dataDir, "app", "server-9.9.9.ok"))).toBe(true);
  }, 40_000);

  it("refuses a broken release and stays on the working one", async () => {
    published = { version: "9.9.10", ...pack("9.9.10", true) };
    expect(await waitFor(async () => existsSync(join(dataDir, "app", "server-9.9.10.bad")))).toBe(true);
    expect(await status()).toContain("Connector version: 9.9.9");
    expect(text(await client.callTool({ name: "list_courses", arguments: {} }))).toContain("course no. 77");
  }, 40_000);
});
