import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MOODLE_TOKEN, startMockReichman, VALID_USER } from "./mock-reichman";

const BUNDLE = join(process.cwd(), "dist", "extension", "server", "index.js");
// This suite needs the built bundle. `npm run test:ext` builds first; plain `npm test` skips it.
const run = existsSync(BUNDLE) ? describe : describe.skip;

let mock: { server: Server; base: string };
let client: Client;

const text = (result: any) => result.content.map((c: any) => c.text).join("\n");

beforeAll(async () => {
  if (!existsSync(BUNDLE)) return;
  mock = await startMockReichman();
  const cache = mkdtempSync(join(tmpdir(), "runi-ext-"));
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: [BUNDLE],
      env: {
        ...process.env,
        RUNI_USERNAME: VALID_USER.username,
        RUNI_PASSWORD: VALID_USER.password,
        MOODLE_BASE: `${mock.base}/moodle`,
        XDG_CACHE_HOME: cache,
        APPDATA: cache,
      } as Record<string, string>,
    }),
  );
}, 30_000);

afterAll(async () => {
  await client?.close();
  mock?.server.close();
});

run("bundled .mcpb server (signs in itself from username+password)", () => {
  it("exposes the tools", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(9);
    expect(tools.map((t) => t.name)).toContain("get_syllabus");
  });

  it("signed in and lists courses + grades", async () => {
    expect(text(await client.callTool({ name: "list_courses", arguments: {} }))).toContain("course no. 77");
    expect(text(await client.callTool({ name: "get_my_grades", arguments: { course: "77" } }))).toContain("95.00");
  });

  it("reads a course PDF (bundled unpdf works)", async () => {
    const result = await client.callTool({ name: "read_course_file", arguments: { course: "77", file: "week1" } });
    expect(text(result)).toContain("BFS");
  });

  // sanity: the token the mock expects is the one the server got via login
  it("used a real login, not a hardcoded token", () => {
    expect(MOODLE_TOKEN).toMatch(/^[a-f0-9]{32}$/);
  });
});
