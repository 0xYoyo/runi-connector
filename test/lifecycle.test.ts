// The account lifecycle, end to end against the built extension and the fake Reichman:
// a saved password that stops working (e.g. the user changed it), signing in again from the
// page without restarting, Piazza on its own, and the sign-in link Claude can show.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { receivedPasswords, startMockReichman, VALID_PIAZZA, VALID_USER } from "./mock-reichman";

const BUNDLE = join(process.cwd(), "dist", "extension", "server", "index.js");
const run = existsSync(BUNDLE) ? describe : describe.skip;

let mock: { server: Server; base: string };
let client: Client;
let dataDir: string;
const OLD_PASSWORD = "old-password-" + Math.random();
const text = (r: any) => r.content.map((c: any) => c.text).join("\n");

function readStore() {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  return JSON.parse(Buffer.from(readFileSync(join(dataDir, "credentials.hex"), "utf8"), "hex").toString());
}

beforeAll(async () => {
  if (!existsSync(BUNDLE)) return;
  mock = await startMockReichman();
  dataDir = mkdtempSync(join(tmpdir(), "runi-life-"));
  // A saved login whose password has since been changed at Reichman.
  const creds = { reichman: { username: VALID_USER.username, password: OLD_PASSWORD } };
  writeFileSync(join(dataDir, "credentials.hex"), Buffer.from(JSON.stringify(creds)).toString("hex"), { mode: 0o600 });
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: [BUNDLE],
      env: {
        ...process.env,
        RUNI_DATA_DIR: dataDir,
        RUNI_SETUP_PORT: "0",
        RUNI_NO_SELF_UPDATE: "1",
        RUNI_NO_BROWSER: "1",
        RUNI_CREDENTIALS_BACKEND: "file",
        MOODLE_BASE: `${mock.base}/moodle`,
        PANOPTO_HOST: mock.base,
        MICHLOL_HOST: mock.base,
        PIAZZA_HOST: mock.base,
      } as Record<string, string>,
    }),
  );
}, 30_000);

afterAll(async () => {
  await client?.close();
  mock?.server.close();
});

run("account lifecycle", () => {
  it("a changed password: clear message with a sign-in link, tried once, never retried", async () => {
    const first = await client.callTool({ name: "list_courses", arguments: {} });
    expect(first.isError).toBe(true);
    expect(text(first)).toMatch(/stopped accepting the saved password/);
    expect(text(first)).toMatch(/http:\/\/127\.0\.0\.1:\d+\/\?k=[0-9a-f]{32}/);
    // more tools, more calls: still no new attempts with the bad password (no account lockout)
    await client.callTool({ name: "get_upcoming_deadlines", arguments: {} });
    await client.callTool({ name: "get_official_grades", arguments: {} });
    await client.callTool({ name: "search_lectures", arguments: { query: "x" } });
    expect(receivedPasswords().filter((p) => p === OLD_PASSWORD).length).toBe(1);
    expect(readStore().reichmanRejected).toBe(true);
  });

  it("connect_account gives a clickable link that serves the page, showing why", async () => {
    const result = await client.callTool({ name: "connect_account", arguments: {} });
    const url = text(result).match(/http:\/\/127\.0\.0\.1:\d+\/\?k=[0-9a-f]{32}/)![0];
    const html = await (await fetch(url)).text();
    expect(html).toContain("stopped accepting your saved password");
  });

  it("signing in again on the page fixes it without a restart", async () => {
    const result = await client.callTool({ name: "connect_account", arguments: {} });
    const url = new URL(text(result).match(/http:\/\/127\.0\.0\.1:\d+\/\?k=[0-9a-f]{32}/)![0]);
    const nonce = url.searchParams.get("k")!;
    const res = await fetch(`${url.origin}/verify-reichman`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Setup-Nonce": nonce, Origin: url.origin },
      body: JSON.stringify({ username: VALID_USER.username, password: VALID_USER.password }),
    });
    expect(await res.json()).toMatchObject({ ok: true });
    expect(readStore().reichmanRejected).toBe(false);
    expect(text(await client.callTool({ name: "list_courses", arguments: {} }))).toContain("course no. 77");
    expect(text(await client.callTool({ name: "get_official_grades", arguments: {} }))).toContain("אלגוריתמים");
  });

  it("Piazza: not connected → points to connect_account; connected → works", async () => {
    const before = await client.callTool({ name: "piazza_list_classes", arguments: {} });
    expect(text(before)).toContain("connect_account");
    const url = new URL(text(await client.callTool({ name: "connect_account", arguments: {} })).match(/http:\/\/127\.0\.0\.1:\d+\/\?k=[0-9a-f]{32}/)![0]);
    const res = await fetch(`${url.origin}/verify-piazza`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Setup-Nonce": url.searchParams.get("k")!, Origin: url.origin },
      body: JSON.stringify({ email: VALID_PIAZZA.email, password: VALID_PIAZZA.password }),
    });
    expect(await res.json()).toMatchObject({ ok: true });
    expect(text(await client.callTool({ name: "piazza_list_classes", arguments: {} }))).toContain("Advanced Programming (3030)");
    expect(text(await client.callTool({ name: "piazza_search", arguments: { course: "3030", query: "HW2" } }))).toContain("@12");
  });

  it("timetable and exams come back readable, without the ID number", async () => {
    const week = text(await client.callTool({ name: "get_weekly_schedule", arguments: {} }));
    expect(week).toContain("יום שני:");
    expect(week).not.toContain("123456789");
    const exams = text(await client.callTool({ name: "get_exam_schedule", arguments: {} }));
    expect(exams).toContain("תאריך: 25/01/2027");
  });
});
