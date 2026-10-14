import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Browser } from "../src/browser";
import { pdfToText } from "../src/documents";
import { MoodleClient, matchCourse } from "../src/moodle";
import { harvestSyllabi } from "../src/syllabi";
import { LoginError, signInToMoodle } from "../src/reichman-login";
import { MOODLE_TOKEN, startMockReichman, VALID_USER } from "./mock-reichman";

// A trivial in-memory stand-in for a Cloudflare KV namespace.
function fakeKV() {
  const store = new Map<string, string>();
  return {
    async get(key: string, type?: "json" | "text") {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    _size: () => store.size,
  } as any;
}

let server: Server;
let base: string;
let moodleBase: string;
let syllabusUrl: string;

beforeAll(async () => {
  const mock = await startMockReichman();
  server = mock.server;
  base = mock.base;
  moodleBase = `${base}/moodle`;
  syllabusUrl = `${base}/myruni/syllabigenerator/pdf/renderdocument?SectionIDC=`;
});

afterAll(() => server.close());

describe("login flow", () => {
  it("walks Moodle → SAML → IdP login → token", async () => {
    const { moodleToken, browser } = await signInToMoodle(moodleBase, VALID_USER);
    expect(moodleToken).toBe(MOODLE_TOKEN);
    expect(browser).toBeInstanceOf(Browser);
  });

  it("rejects wrong credentials with bad_credentials", async () => {
    await expect(signInToMoodle(moodleBase, { username: "student1", password: "wrong" })).rejects.toMatchObject({
      code: "bad_credentials",
    });
  });

  it("never puts the password in error messages or the request trace", async () => {
    const password = "Sup3r-Secret-Value";
    const browser = new Browser();
    const error = await signInToMoodle(moodleBase, { username: "student1", password }, { browser }).catch((e) => e);
    expect(error).toBeInstanceOf(LoginError);
    expect(String(error.message)).not.toContain(password);
    expect(JSON.stringify(browser.trace)).not.toContain(password);
  });

  it("reports mfa_required when the IdP asks for a second step", async () => {
    const mock = await startMockReichman(0, { requireMfa: true });
    try {
      await expect(signInToMoodle(`${mock.base}/moodle`, VALID_USER)).rejects.toMatchObject({
        code: "mfa_required",
      });
    } finally {
      mock.server.close();
    }
  });
});

describe("moodle API", () => {
  it("reads site info, courses, grades, deadlines", async () => {
    const moodle = new MoodleClient(moodleBase, MOODLE_TOKEN);
    const site = await moodle.siteInfo();
    expect(site.userid).toBe(42);

    const courses = await moodle.courses(site.userid);
    expect(courses.map((c) => c.courseNumber)).toContain("77");
    expect(matchCourse(courses, "77")?.fullname).toBe("אלגוריתמים");
    expect(matchCourse(courses, "advanced")?.courseNumber).toBe("3030");
  });

  it("rejects an invalid token as an expired session", async () => {
    const moodle = new MoodleClient(moodleBase, "deadbeef");
    await expect(moodle.siteInfo()).rejects.toThrow(/access has expired/);
  });

  it("downloads and reads a course PDF via the token", async () => {
    const moodle = new MoodleClient(moodleBase, MOODLE_TOKEN);
    const { bytes, contentType } = await moodle.downloadFile(
      `${base}/moodle/webservice/pluginfile.php/1/mod_resource/content/0/week1-graphs.pdf`,
    );
    expect(contentType).toContain("pdf");
    const { text } = await pdfToText(bytes);
    expect(text).toContain("BFS");
  });
});

describe("syllabus harvest", () => {
  it("collects syllabi into KV, caches them, and parses the text", async () => {
    const kv = fakeKV();
    const moodle = new MoodleClient(moodleBase, MOODLE_TOKEN);
    const courses = await moodle.courses(42);
    const { browser } = await signInToMoodle(moodleBase, VALID_USER);

    const report = await harvestSyllabi(kv, browser, moodleBase, courses, VALID_USER, syllabusUrl);
    expect(report.syllabiFetched).toBe(2); // course 77 has two groups; 3030 has none
    expect(report.failures).toEqual([]);

    const cached = await kv.get("syllabus:1813792", "json");
    expect(cached.text).toContain("0.65");

    // A second harvest should hit the cache, not refetch.
    const { browser: browser2 } = await signInToMoodle(moodleBase, VALID_USER);
    const report2 = await harvestSyllabi(kv, browser2, moodleBase, courses, VALID_USER, syllabusUrl);
    expect(report2.syllabiFetched).toBe(0);
    expect(report2.alreadyCached).toBe(2);
  });
});
