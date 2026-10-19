// Startup must always answer Claude. The launcher runs the connector in a worker thread (child
// processes don't work under Claude Desktop's built-in Node.js, seen live 2026-10-19); if that
// can't load, crashes, or hangs, the connector is served in the launcher itself.
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMockReichman, VALID_USER } from "./mock-reichman";

const BUNDLE = join(process.cwd(), "dist", "extension", "server", "index.js");
const run = existsSync(BUNDLE) ? describe : describe.skip;

// A stand-in for the connector code the launcher loads in its worker thread.
function script(body: string) {
  const path = join(mkdtempSync(join(tmpdir(), "child-")), "child.js");
  writeFileSync(path, body);
  return path;
}

async function startWith(childExec: string) {
  const mock = await startMockReichman();
  const dataDir = mkdtempSync(join(tmpdir(), "runi-start-"));
  writeFileSync(join(dataDir, "credentials.hex"), Buffer.from(JSON.stringify({ reichman: VALID_USER })).toString("hex"), { mode: 0o600 });
  const client = new Client({ name: "test", version: "1.0.0" });
  const started = Date.now();
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: [BUNDLE],
      env: {
        ...process.env,
        RUNI_DATA_DIR: dataDir,
        RUNI_SETUP_PORT: "0",
        RUNI_NO_SELF_UPDATE: "1",
        RUNI_TEST_MODE: "1",
        RUNI_NO_BROWSER: "1",
        RUNI_CREDENTIALS_BACKEND: "file",
        RUNI_CHILD_FILE: childExec,
        RUNI_STARTUP_TIMEOUT_MS: "1500",
        MOODLE_BASE: `${mock.base}/moodle`,
      } as Record<string, string>,
    }),
  );
  const connectMs = Date.now() - started;
  const tools = (await client.listTools()).tools.map((t) => t.name);
  const courses = await client.callTool({ name: "list_courses", arguments: {} });
  await client.close();
  mock.server.close();
  return { connectMs, tools, courses: (courses as any).content.map((c: any) => c.text).join("\n") };
}

run("startup always answers", () => {
  it("connector code can't be loaded → served in-process", async () => {
    const r = await startWith("/nonexistent/server.js");
    expect(r.tools).toContain("list_courses");
    expect(r.courses).toContain("אלגוריתמים");
  });

  it("connector code crashes at once → served in-process, quickly", async () => {
    const r = await startWith(script("throw new Error('boom');"));
    expect(r.connectMs).toBeLessThan(5000);
    expect(r.courses).toContain("אלגוריתמים");
  });

  it("connector code hangs without answering → served in-process after the startup timeout", async () => {
    const r = await startWith(script("setInterval(() => {}, 1000);"));
    expect(r.connectMs).toBeLessThan(8000);
    expect(r.tools).toContain("get_zoom_links");
    expect(r.courses).toContain("אלגוריתמים");
  }, 20_000);
});
