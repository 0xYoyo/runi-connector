// Startup must always answer Claude, even where the launcher can't run the connector as a child
// process (seen live 2026-10-19: Claude Desktop's built-in Node.js is Electron, and a child started
// with it as a plain program never answered). Then the connector is served in the launcher itself.
import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMockReichman, VALID_USER } from "./mock-reichman";

const BUNDLE = join(process.cwd(), "dist", "extension", "server", "index.js");
const run = existsSync(BUNDLE) ? describe : describe.skip;

function script(body: string) {
  const path = join(mkdtempSync(join(tmpdir(), "exec-")), "child.sh");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
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
        RUNI_CHILD_EXEC: childExec,
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
  it("child program can't be started → served in-process", async () => {
    const r = await startWith("/nonexistent/node");
    expect(r.tools).toContain("list_courses");
    expect(r.courses).toContain("אלגוריתמים");
  });

  it("child exits immediately → served in-process, quickly", async () => {
    const r = await startWith(script("exit 1"));
    expect(r.connectMs).toBeLessThan(5000);
    expect(r.courses).toContain("אלגוריתמים");
  });

  it("child hangs without answering → served in-process after the startup timeout", async () => {
    const r = await startWith(script("exec sleep 600"));
    expect(r.connectMs).toBeLessThan(8000);
    expect(r.tools).toContain("get_zoom_links");
    expect(r.courses).toContain("אלגוריתמים");
  }, 20_000);
});
