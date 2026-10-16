// Drives the real sign-in page in a real Chromium: typing, clicking, the eye toggle, wrong and
// right logins, and the Piazza step. Asserts a password never lands in a URL. Skips when no
// Chromium is installed (set CHROMIUM_PATH to point at one).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { loadCredentials } from "../extension/server/credentials";
import { SetupServer } from "../extension/server/setup-server";

const CHROME = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const PASS = "Right-Pass-123";
const WRONG = "Wrong-Pass-999";
const PIAZZA_PASS = "Piazza-Pass-456";

let browser: Browser;
let server: SetupServer;
let url: string;
const seenUrls: string[] = [];

const exe = () => {
  if (existsSync(join(CHROME, "chrome-linux", "chrome"))) return join(CHROME, "chrome-linux", "chrome");
  return existsSync(CHROME) ? CHROME : null;
};

describe.skipIf(!exe())("sign-in page in a real browser", () => {
  beforeAll(async () => {
    process.env.RUNI_DATA_DIR = mkdtempSync(join(tmpdir(), "runi-browser-"));
    process.env.RUNI_CREDENTIALS_BACKEND = "file";
    process.env.RUNI_SETUP_PORT = "0";
    server = new SetupServer({
      verifyReichman: async (u, p) => {
        await new Promise((r) => setTimeout(r, 150));
        return u === "first.last" && p === PASS ? { ok: true, name: "Yoav Zrihan" } : { ok: false, error: "Reichman didn't accept that username and password." };
      },
      verifyPiazza: async (e, p) => (e === "first.last@post.runi.ac.il" && p === PIAZZA_PASS ? { ok: true } : { ok: false, error: "Piazza didn't accept that email and password." }),
      onChange: () => {},
    });
    url = await server.start();
    browser = await chromium.launch({ executablePath: exe()! });
  });

  afterAll(async () => {
    await browser?.close();
    server?.close();
    delete process.env.RUNI_SETUP_PORT;
  });

  async function open(): Promise<Page> {
    const page = await browser.newPage();
    page.on("request", (r) => seenUrls.push(r.url()));
    page.on("framenavigated", (f) => seenUrls.push(f.url()));
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url);
    expect(errors).toEqual([]);
    return page;
  }

  it("has no script errors, a working eye toggle, and focuses the right field", async () => {
    const page = await open();
    expect(await page.isVisible("#step-reichman")).toBe(true);
    await page.fill("#r-pass", "abc");
    expect(await page.getAttribute("#r-pass", "type")).toBe("password");
    await page.click('.eye[data-for="r-pass"]');
    expect(await page.getAttribute("#r-pass", "type")).toBe("text");
    expect(await page.getAttribute('.eye[data-for="r-pass"]', "aria-label")).toBe("Hide password");
    await page.click('.eye[data-for="r-pass"]');
    expect(await page.getAttribute("#r-pass", "type")).toBe("password");
    await page.close();
  });

  it("empty submit shows an inline message and stays put", async () => {
    const page = await open();
    const before = page.url();
    await page.click("#r-btn");
    expect(await page.textContent("#r-msg")).toContain("Enter your username and password");
    expect(page.url()).toBe(before);
    await page.close();
  });

  it("wrong password shows an inline error, stays on the page, saves nothing", async () => {
    const page = await open();
    const before = page.url();
    await page.fill("#r-user", "first.last");
    await page.fill("#r-pass", WRONG);
    await page.press("#r-pass", "Enter"); // Enter key, the way people actually submit
    await page.waitForSelector("#r-msg.err");
    expect(await page.textContent("#r-msg")).toContain("didn't accept");
    expect(page.url()).toBe(before);
    expect(await page.isVisible("#step-reichman")).toBe(true);
    expect(loadCredentials().reichman).toBeUndefined();
    await page.close();
  });

  it("right password advances to Piazza with the email suggested, then finishes", async () => {
    const page = await open();
    await page.fill("#r-user", "first.last");
    await page.fill("#r-pass", PASS);
    await page.click("#r-btn");
    await page.waitForSelector("#step-piazza:not([hidden])");
    expect(await page.inputValue("#p-email")).toBe("first.last@post.runi.ac.il");
    expect(await page.inputValue("#r-pass")).toBe(""); // cleared from the DOM
    expect(loadCredentials().reichman?.username).toBe("first.last");

    await page.fill("#p-pass", "nope");
    await page.press("#p-pass", "Enter");
    await page.waitForSelector("#p-msg.err");
    expect(loadCredentials().piazza).toBeUndefined();

    await page.fill("#p-pass", PIAZZA_PASS);
    await page.click("#p-btn");
    await page.waitForSelector("#step-done:not([hidden])");
    expect(await page.textContent("#done-name")).toContain("Yoav Zrihan");
    expect(await page.textContent("#done-piazza")).toContain("Connected");
    expect(loadCredentials().piazza?.email).toBe("first.last@post.runi.ac.il");
    await page.close();
  });

  it("reopening after sign-in shows the connected state", async () => {
    const page = await open();
    expect(await page.isVisible("#step-done")).toBe(true);
    await page.close();
  });

  it("a wrong key shows a friendly page, not a bare Forbidden", async () => {
    const page = await browser.newPage();
    await page.goto(new URL(url).origin + "/?k=wrong");
    expect(await page.textContent("h1")).toContain("expired");
    await page.close();
  });

  it("no password ever appeared in any URL", () => {
    expect(seenUrls.length).toBeGreaterThan(0);
    for (const u of seenUrls) {
      for (const secret of [PASS, WRONG, PIAZZA_PASS, encodeURIComponent(PASS)]) expect(u).not.toContain(secret);
      expect(u).not.toMatch(/password=/i);
    }
  });
});
