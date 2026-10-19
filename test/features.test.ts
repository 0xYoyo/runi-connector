// The extra Moodle features, end to end against the built extension and the fake Reichman:
// forums, feedback, quizzes, what's new, attendance, Zoom links, Panopto via the course's
// activity, and actions that change things only after a confirmed preview.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ltiLaunches, startMockReichman, VALID_USER, writes } from "./mock-reichman";

const BUNDLE = join(process.cwd(), "dist", "extension", "server", "index.js");
const run = existsSync(BUNDLE) ? describe : describe.skip;

let mock: { server: Server; base: string };
let client: Client;
let home: string;
const text = (r: any) => r.content.map((c: any) => c.text).join("\n");
const call = async (name: string, args: Record<string, unknown> = {}) => text(await client.callTool({ name, arguments: args }));

beforeAll(async () => {
  if (!existsSync(BUNDLE)) return;
  mock = await startMockReichman();
  const dataDir = mkdtempSync(join(tmpdir(), "runi-feat-"));
  home = mkdtempSync(join(tmpdir(), "runi-home-"));
  writeFileSync(join(dataDir, "credentials.hex"), Buffer.from(JSON.stringify({ reichman: VALID_USER })).toString("hex"), { mode: 0o600 });
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: [BUNDLE],
      env: {
        ...process.env,
        RUNI_DATA_DIR: dataDir,
        HOME: home,
        RUNI_SETUP_PORT: "0",
        RUNI_NO_SELF_UPDATE: "1",
        RUNI_TEST_MODE: "1",
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

run("more of Moodle", () => {
  it("forums: lists discussions and reads one", async () => {
    expect(await call("get_forum_discussions", { course: "77" })).toContain("[discussion 9001]");
    const posts = await call("read_forum_discussion", { discussion_id: 9001 });
    expect(posts).toContain("Is Q2 graded?");
    expect(posts).toContain("Yes, 20 points.");
  });

  it("assignment feedback and quiz results", async () => {
    const fb = await call("get_assignment_feedback", { course: "77" });
    expect(fb).toContain("92.00 / 100.00");
    expect(fb).toContain("Nice proof in Q2");
    const quiz = await call("get_quiz_results", { course: "77" });
    expect(quiz).toContain("Best grade: 8/10");
    expect(quiz).toContain("8.00/10");
    expect(quiz).toContain("Good job");
  });

  it("what's new and attendance", async () => {
    expect(await call("whats_new", { days: 7 })).toContain("Week 1 - Graphs: configuration, fileareas");
    const att = await call("get_attendance", { course: "77" });
    expect(att).toContain("Sun 19 Oct | Absent");
    expect(att).not.toContain("menu");
    expect(att).not.toContain("Font Kerning");
    expect(att).not.toContain("SECRETKEY");
  });

  it("course names are unescaped; files open by their title too", async () => {
    expect(await call("get_course_contents", { course: "77" })).toContain("Recitation 1 - Intro & Toposort");
    const byTitle = await call("read_course_file", { course: "77", file: "Toposort" });
    expect(byTitle).toContain("rec1.pdf");
  });

  it("reads Moodle pages only on Moodle", async () => {
    expect(await call("read_moodle_page", { url: `${mock.base}/moodle/mod/attendance/view.php?id=23` })).toContain("Present");
    expect(await call("read_moodle_page", { url: "https://example.com/x" })).toMatch(/Only links on Reichman's Moodle/);
  });

  it("Zoom links from the course page and the Zoom activity", async () => {
    const zoom = await call("get_zoom_links", { course: "77" });
    expect(zoom).toContain("https://runi.zoom.us/j/111222333?pwd=abc&x=1");
    expect(zoom).toContain("https://runi.zoom.us/j/444555666");
    expect(zoom).toContain("1 upcoming meeting(s)");
    expect(zoom).toContain("Algorithms lecture — Mon 26 Oct 11:30 (150 min) — https://runi.zoom.us/j/999888777?pwd=zz");
    expect(zoom).toContain("Algorithms lecture (last week)");
  });

  it("Panopto signs in through the course's Panopto activity", async () => {
    expect(await call("search_lectures", { query: "probability" })).toContain("id: rec-5");
    expect(ltiLaunches).toContain("21");
  });

  it("forum post: nothing is posted until the preview is confirmed; codes work once", async () => {
    const before = writes.length;
    const prepared = await call("post_to_forum", { course: "77", reply_to_discussion: 9001, message: "Thanks!" });
    expect(prepared).toContain("NOT posted yet");
    expect(writes.length).toBe(before);
    const code = prepared.match(/code ([0-9A-F]{6})/)![1];
    expect(await call("confirm_action", { code })).toContain("Posted your reply");
    expect(writes.at(-1)).toMatchObject({ fn: "mod_forum_add_discussion_post", params: { postid: "7001", message: "Thanks!" } });
    expect(await call("confirm_action", { code })).toMatch(/unknown or expired/);
  });

  it("assignment submission: preview, then upload + save + submit on confirm; home folder only", async () => {
    mkdirSync(join(home, "Desktop"), { recursive: true });
    writeFileSync(join(home, "Desktop", "hw2.pdf"), "%PDF-1.4 fake");
    const before = writes.length;
    const prepared = await call("submit_assignment", { course: "77", assignment: "HW2", files: ["~/Desktop/hw2.pdf"] });
    expect(prepared).toContain('Submit to "HW2 - Trees"');
    expect(prepared).toContain("hw2.pdf");
    expect(writes.length).toBe(before);
    const code = prepared.match(/code ([0-9A-F]{6})/)![1];
    expect(await call("confirm_action", { code })).toContain('Submitted to "HW2 - Trees"');
    expect(writes.slice(before).map((w) => w.fn)).toEqual(["upload", "mod_assign_save_submission", "mod_assign_submit_for_grading"]);
    expect(writes[before + 1].params["plugindata[files_filemanager]"]).toBe("777");
    expect(await call("submit_assignment", { course: "77", assignment: "HW2", files: ["/etc/passwd"] })).toMatch(/Only files inside your home folder/);
  });
});
