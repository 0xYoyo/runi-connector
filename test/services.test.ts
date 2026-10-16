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
    const grades = await michlol.grades();
    expect(grades.map((g) => g.grade)).toEqual(["95", "טרם"]);
  });

  it("signs in again once when the session was logged out", async () => {
    const { browser } = await signInToMoodle(`${base}/moodle`, VALID_USER);
    const michlol = new MichlolClient(browser, base, () => VALID_USER);
    await michlol.grades();
    // Simulate the session expiring on the server side: drop the Michlol cookies.
    const expired = new Browser();
    (michlol as any).browser = expired;
    const grades = await michlol.grades();
    expect(grades).toHaveLength(2);
  });

  it("fails clearly without a saved login", async () => {
    const michlol = new MichlolClient(new Browser(), base, () => undefined);
    await expect(michlol.grades()).rejects.toThrow(/Not connected/);
  });
});

describe("Panopto", () => {
  it("follows the Moodle hand-off and finds recordings", async () => {
    const { browser } = await signInToMoodle(`${base}/moodle`, VALID_USER);
    const panopto = new PanoptoClient(browser, 2027, base, () => VALID_USER);
    const results = await panopto.search("probability");
    expect(results[0]?.deliveryId).toBe("rec-5");
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
