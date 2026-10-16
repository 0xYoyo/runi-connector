// The bugs found in live testing on 2026-10-16, reproduced against the fake Reichman:
// wrong password -> dead-end page; Student Info Station needing its own gateway login;
// Panopto's auto-post hand-off; Piazza's real form login + CSRF-Token API.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Browser } from "../src/browser";
import { isReichmanHost, LoginError, signInToMoodle } from "../src/reichman-login";
import { MichlolClient } from "../src/michlol";
import { PanoptoClient } from "../src/panopto";
import { PiazzaAuthError, PiazzaClient } from "../src/piazza";
import { receivedPasswords, startMockReichman, VALID_PIAZZA, VALID_USER } from "./mock-reichman";

let server: Server;
let base: string;
let formServer: Server;
let formBase: string;

beforeAll(async () => {
  ({ server, base } = await startMockReichman());
  ({ server: formServer, base: formBase } = await startMockReichman(0, { wrongPasswordShowsForm: true }));
});
afterAll(() => {
  server.close();
  formServer.close();
});

const attemptsWith = (password: string) => receivedPasswords().filter((p) => p === password).length;

describe("wrong Reichman password", () => {
  it("a dead-end 'access denied' page reads as a wrong password, sent only once", async () => {
    const wrong = "wrong-" + Math.random();
    const error = await signInToMoodle(`${base}/moodle`, { username: VALID_USER.username, password: wrong }).catch((e) => e);
    expect(error).toBeInstanceOf(LoginError);
    expect(error.code).toBe("bad_credentials");
    expect(error.afterPassword).toBe(true);
    expect(error.message).not.toContain("HTTP");
    expect(attemptsWith(wrong)).toBe(1);
  });

  it("a login form shown again is a wrong password too, and is not resubmitted", async () => {
    const wrong = "wrong-" + Math.random();
    const error = await signInToMoodle(`${formBase}/moodle`, { username: VALID_USER.username, password: wrong }).catch((e) => e);
    expect(error.code).toBe("bad_credentials");
    expect(attemptsWith(wrong)).toBe(1);
  });

  it("an unrelated dead end after the password is an error, NOT a wrong password", async () => {
    const { navigateThroughLogin } = await import("../src/reichman-login");
    const error = await navigateThroughLogin(new Browser(), `${base}/trap/start`, VALID_USER, () => false).catch((e) => e);
    expect(error).toBeInstanceOf(LoginError);
    expect(error.code).toBe("unexpected_page");
  });

  it("the login page shown again WITHOUT Reichman's error text is not a wrong password (overlapping sign-ins)", async () => {
    const { navigateThroughLogin } = await import("../src/reichman-login");
    const before = receivedPasswords().length;
    const error = await navigateThroughLogin(new Browser(), `${base}/trap2/start`, VALID_USER, () => false).catch((e) => e);
    expect(error.code).toBe("unexpected_page");
    expect(receivedPasswords().length).toBe(before); // trap2 doesn't record, and nothing was resent
  });

  it("only treats Reichman hosts as places to type the Reichman password", () => {
    expect(isReichmanHost("my.runi.ac.il")).toBe(true);
    expect(isReichmanHost("auth.runi.ac.il")).toBe(true);
    expect(isReichmanHost("runi.cloud.panopto.eu")).toBe(false);
    expect(isReichmanHost("piazza.com")).toBe(false);
    expect(isReichmanHost("runi.ac.il.evil.com")).toBe(false);
  });
});

describe("Student Info Station", () => {
  it("signs in through its own gateway, then reads grades", async () => {
    const { browser } = await signInToMoodle(`${base}/moodle`, VALID_USER);
    const michlol = new MichlolClient(browser, base, () => VALID_USER);
    const { data: grades, selection } = await michlol.grades();
    expect(grades.map((g) => `${g.course}|${g.component}|${g.sitting}|${g.grade}`)).toEqual([
      "77 אלגוריתמים|שיעור|1|95",
      "77 אלגוריתמים|תרגול|1|88",
      "52 חשבון אינפיניטיסמלי א'|שיעור|2|81",
      "109 מבוא להסתברות|שיעור|1|טרם",
      "5400 יזמות פינטק|סדנה|1|טרם",
    ]);
    expect(selection.years).toEqual(["2027", "2026"]);
  });

  it("timetable uses the page's current semester and is grouped by day, without the ID number", async () => {
    const { browser } = await signInToMoodle(`${base}/moodle`, VALID_USER);
    const michlol = new MichlolClient(browser, base, () => VALID_USER);
    const { data, selection } = await michlol.weeklySchedule();
    expect(selection.semester).toBe("1");
    expect(data).toContain("יום שני:\n  - 109-מבוא להסתברות");
    expect(data).toContain("יום שלישי:\n  - 3030-תכנות מתקדם");
    expect(data).not.toContain("המשך");
    expect(data).toContain("  - 669-הרצאת אורח-מדעי המחשב שיעור C.L05 אודיטוריום צ'ייס 14:30-15:30");
    expect(data).not.toContain("123456789");
  });

  it("exam schedule uses the exam screen's own submit and labels each column", async () => {
    const { browser } = await signInToMoodle(`${base}/moodle`, VALID_USER);
    const michlol = new MichlolClient(browser, base, () => VALID_USER);
    const { data } = await michlol.examSchedule();
    expect(data).toContain("- מועד: 1; קוד קורס: 77; שם קורס: אלגוריתמים; תאריך: 25/01/2027");
    expect(data).toContain("מועד: 2");
    expect(data).not.toContain("בית ספר");
  });

  it("signs in again once when the session was logged out", async () => {
    const { browser } = await signInToMoodle(`${base}/moodle`, VALID_USER);
    const michlol = new MichlolClient(browser, base, () => VALID_USER);
    await michlol.grades();
    // Simulate the session expiring on the server side: drop the Michlol cookies.
    const expired = new Browser();
    (michlol as any).browser = expired;
    const { data: grades } = await michlol.grades();
    expect(grades).toHaveLength(5);
  });

  it("fails clearly without a saved login", async () => {
    const michlol = new MichlolClient(new Browser(), base, () => undefined);
    await expect(michlol.grades()).rejects.toThrow(/Not connected/);
  });
});

describe("Panopto", () => {
  it("signs in via IDCPROD (warming up the My RUNI gateway on 'access not found') and finds recordings", async () => {
    const { browser } = await signInToMoodle(`${base}/moodle`, VALID_USER);
    const michlol = new MichlolClient(browser, base, () => VALID_USER);
    const panopto = new PanoptoClient(browser, 2027, base, () => VALID_USER, () => michlol.ensureSignedIn());
    const results = await panopto.search("probability");
    expect(results[0]?.deliveryId).toBe("rec-5");
  });

  it("without the gateway fallback, a dead end is a clear error, not a hang", async () => {
    const { browser } = await signInToMoodle(`${base}/moodle`, VALID_USER);
    const panopto = new PanoptoClient(browser, 2027, base, () => VALID_USER);
    await expect(panopto.search("x")).rejects.toThrow(/unexpected page|circles/);
  });
});

describe("Piazza", () => {
  it("signs in with the real form flow and lists classes", async () => {
    const piazza = new PiazzaClient(new Browser(), base);
    await piazza.login(VALID_PIAZZA.email, VALID_PIAZZA.password);
    expect((await piazza.classes())[0]).toMatchObject({ id: "net1", num: "3030" });
    expect((await piazza.search("net1", "HW2"))[0].subject).toBe("HW2 deadline");
    expect((await piazza.post("net1", 12)).content).toBe("Is it Thursday?");
  });

  it("rejects a wrong password as an auth error", async () => {
    const piazza = new PiazzaClient(new Browser(), base);
    await expect(piazza.login(VALID_PIAZZA.email, "nope")).rejects.toBeInstanceOf(PiazzaAuthError);
  });
});
