import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MOODLE_TOKEN, startMockReichman } from "./mock-reichman";

let mock: { server: Server; base: string };
let client: Client;

const text = (result: any) => result.content.map((c: any) => c.text).join("\n");

beforeAll(async () => {
  mock = await startMockReichman();
  const dataDir = mkdtempSync(join(tmpdir(), "runi-local-"));
  writeFileSync(
    join(dataDir, "session.json"),
    JSON.stringify({ moodleToken: MOODLE_TOKEN, moodleBase: `${mock.base}/moodle`, userId: 42, fullName: "Test Student" }),
  );
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: join(process.cwd(), "node_modules/.bin/tsx"),
      args: [join(process.cwd(), "local/server.ts")],
      env: { ...process.env, RUNI_CONNECTOR_DIR: dataDir } as Record<string, string>,
    }),
  );
}, 30_000);

afterAll(async () => {
  await client?.close();
  mock?.server.close();
});

describe("local stdio server", () => {
  it("exposes the tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["list_courses", "get_syllabus", "get_my_grades", "read_course_file"]),
    );
  });

  it("lists courses and grades from Moodle", async () => {
    expect(text(await client.callTool({ name: "list_courses", arguments: {} }))).toContain("course no. 77");
    expect(text(await client.callTool({ name: "get_my_grades", arguments: { course: "77" } }))).toContain("HW1: 95.00");
  });

  it("reads a course PDF", async () => {
    const result = await client.callTool({
      name: "read_course_file",
      arguments: { course: "algorithms", file: "week1" },
    });
    expect(text(result)).toContain("BFS");
  });
});
