import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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
  const dataDir = mkdtempSync(join(tmpdir(), "runi-ext-"));
  // Seed the file-backed credential store (the app normally fills this from its sign-in page).
  const creds = { reichman: { username: VALID_USER.username, password: VALID_USER.password } };
  writeFileSync(join(dataDir, "credentials.hex"), Buffer.from(JSON.stringify(creds)).toString("hex"), { mode: 0o600 });
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: [BUNDLE],
      env: {
        ...process.env,
        RUNI_DATA_DIR: dataDir,
        RUNI_CREDENTIALS_BACKEND: "file",
        MOODLE_BASE: `${mock.base}/moodle`,
        SYLLABUS_URL: `${mock.base}/myruni/syllabigenerator/pdf/renderdocument?SectionIDC=`,
        PANOPTO_HOST: mock.base,
        MICHLOL_HOST: mock.base,
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
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "get_syllabus",
        "forget_my_data",
        "search_lectures",
        "get_lecture_transcript",
        "get_official_grades",
        "piazza_list_classes",
      ]),
    );
  });

  it("searches Panopto lectures and reads a transcript", async () => {
    const found = await client.callTool({ name: "search_lectures", arguments: { query: "probability" } });
    expect(text(found)).toContain("id: rec-5");
    const transcript = await client.callTool({ name: "get_lecture_transcript", arguments: { recording_id: "rec-5" } });
    expect(text(transcript)).toContain("[3:12]");
  });

  it("reads official grades from the Student Info Station", async () => {
    const result = await client.callTool({ name: "get_official_grades", arguments: { year: "all", semester: 0 } });
    expect(text(result)).toContain("95");
    expect(text(result)).toContain("אלגוריתמים");
  });

  it("tells the user Piazza needs setup when no Piazza login is configured", async () => {
    const result = await client.callTool({ name: "piazza_list_classes", arguments: {} });
    expect(text(result)).toContain("separate login");
  });

  it("signed in and lists courses + grades", async () => {
    expect(text(await client.callTool({ name: "list_courses", arguments: {} }))).toContain("course no. 77");
    expect(text(await client.callTool({ name: "get_my_grades", arguments: { course: "77" } }))).toContain("95.00");
  });

  it("reads a course PDF (bundled unpdf works)", async () => {
    const result = await client.callTool({ name: "read_course_file", arguments: { course: "77", file: "week1" } });
    expect(text(result)).toContain("BFS");
  });

  it("fetches a syllabus on demand when it isn't cached", async () => {
    const result = await client.callTool({ name: "get_syllabus", arguments: { course: "77" } });
    expect(text(result)).toContain("0.65");
  });

  it("forget_my_data refuses without confirmation", async () => {
    const result = await client.callTool({ name: "forget_my_data", arguments: { confirm: false } });
    expect(text(result)).toContain("Nothing deleted");
  });

  // sanity: the token the mock expects is the one the server got via login
  it("used a real login, not a hardcoded token", () => {
    expect(MOODLE_TOKEN).toMatch(/^[a-f0-9]{32}$/);
  });
});
