// Regression tests for the pre-publish security audit (2026-10-16).
import { afterEach, describe, expect, it } from "vitest";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../src/browser";
import { isReichmanHost, navigateThroughLogin } from "../src/reichman-login";
import { PiazzaClient } from "../src/piazza";
import { SetupServer } from "../extension/server/setup-server";

const PASSWORD = "S3cret-Pass!";

// A fake fetch that records every request and answers from a script of responses.
function scripted(routes: Record<string, () => Response>) {
  const log: Array<{ method: string; url: string; body: string; referer: string }> = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    log.push({ method: init?.method ?? "GET", url, body: String(init?.body ?? ""), referer: headers.Referer ?? "" });
    const route = routes[url.split("?")[0]];
    return route ? route() : new Response("not found", { status: 404 });
  };
  return { fetchFn, log };
}
const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });
const leaked = (log: Array<{ url: string; body: string; referer: string }>) =>
  log.some((r) => /evil|thirdparty/.test(r.url) && r.body.includes(encodeURIComponent(PASSWORD)));

describe("the password can't be carried off-site", () => {
  it("a 307 redirect to another site is refused instead of resending the form", async () => {
    const { fetchFn, log } = scripted({
      "https://auth.runi.ac.il/start": () =>
        html(`<form method="post" action="https://auth.runi.ac.il/login"><input name="username"><input type="password" name="password"></form>`),
      "https://auth.runi.ac.il/login": () => new Response(null, { status: 307, headers: { location: "https://evil.example/collect" } }),
    });
    const error = await navigateThroughLogin(new Browser(fetchFn), "https://auth.runi.ac.il/start", { username: "u", password: PASSWORD }, () => false).catch((e) => e);
    expect(String(error.message)).toMatch(/Refused to resend form data/);
    expect(leaked(log)).toBe(false);
    expect(log.some((r) => r.url.includes("evil"))).toBe(false);
  });

  it("a GET password form, or one on plain HTTP, never gets the password", async () => {
    for (const form of [
      `<form method="get" action="https://auth.runi.ac.il/l"><input name="user"><input type="password" name="pw"></form>`,
      `<form method="post" action="http://auth.runi.ac.il/l"><input name="user"><input type="password" name="pw"></form>`,
    ]) {
      const { fetchFn, log } = scripted({ "https://auth.runi.ac.il/start": () => html(form) });
      const error = await navigateThroughLogin(new Browser(fetchFn), "https://auth.runi.ac.il/start", { username: "u", password: PASSWORD }, () => false).catch((e) => e);
      expect(error.message).toMatch(/wasn't sent/);
      expect(log.some((r) => r.url.includes(encodeURIComponent(PASSWORD)) || r.body.includes(encodeURIComponent(PASSWORD)))).toBe(false);
    }
  });

  it("Referer never carries a query string", async () => {
    const { fetchFn, log } = scripted({ "https://a.runi.ac.il/x": () => html("ok") });
    await new Browser(fetchFn).request("https://a.runi.ac.il/x", { referer: "https://a.runi.ac.il/p?token=abc" });
    expect(log[0].referer).toBe("https://a.runi.ac.il/p");
  });

  it("loopback is a Reichman host only in test mode", () => {
    expect(isReichmanHost("127.0.0.1")).toBe(true); // tests run with RUNI_TEST_MODE=1
    process.env.RUNI_TEST_MODE = "0";
    try {
      expect(isReichmanHost("127.0.0.1")).toBe(false);
      expect(isReichmanHost("localhost")).toBe(false);
      expect(isReichmanHost("my.runi.ac.il")).toBe(true);
    } finally {
      process.env.RUNI_TEST_MODE = "1";
    }
  });

  it("the Piazza password only goes to piazza.com", async () => {
    const { fetchFn, log } = scripted({
      "https://piazza.com/account/login": () =>
        html(`<form method="post" action="https://thirdparty.example/sso"><input name="email"><input type="password" name="password"></form>`),
    });
    const error = await new PiazzaClient(new Browser(fetchFn)).login("a@b.c", PASSWORD).catch((e) => e);
    expect(error.message).toMatch(/wasn't sent/);
    expect(leaked(log)).toBe(false);
  });
});

describe("the local sign-in page can't be impersonated or rebound", () => {
  let servers: Array<{ close(): void }> = [];
  afterEach(() => {
    servers.forEach((s) => s.close());
    servers = [];
  });

  it("a look-alike squatting the port doesn't get the sign-in link", async () => {
    process.env.RUNI_DATA_DIR = mkdtempSync(join(tmpdir(), "runi-sec-"));
    // Impostor answers /__runi like the old, unauthenticated version did.
    const impostor = createServer((_req, res) => res.end(JSON.stringify({ app: "reichman-courses-connector", proof: "0".repeat(64) })));
    await new Promise<void>((r) => impostor.listen(0, "127.0.0.1", r));
    servers.push(impostor);
    const port = (impostor.address() as { port: number }).port;
    process.env.RUNI_SETUP_PORT = String(port);
    const setup = new SetupServer({ verifyReichman: async () => ({ ok: false }), verifyPiazza: async () => ({ ok: false }), onChange() {} });
    servers.push(setup);
    const url = await setup.start();
    expect(new URL(url).port).not.toBe(String(port));
    expect((await fetch(url)).status).toBe(200);
    process.env.RUNI_SETUP_PORT = "0";
  });

  it("a second real connector process is recognised (it knows the private key)", async () => {
    process.env.RUNI_DATA_DIR = mkdtempSync(join(tmpdir(), "runi-sec-"));
    process.env.RUNI_SETUP_PORT = "0";
    const first = new SetupServer({ verifyReichman: async () => ({ ok: false }), verifyPiazza: async () => ({ ok: false }), onChange() {} });
    servers.push(first);
    const url1 = await first.start();
    process.env.RUNI_SETUP_PORT = new URL(url1).port;
    const second = new SetupServer({ verifyReichman: async () => ({ ok: false }), verifyPiazza: async () => ({ ok: false }), onChange() {} });
    servers.push(second);
    expect(await second.start()).toBe(url1);
    process.env.RUNI_SETUP_PORT = "0";
  });

  it("requests with another Host header (DNS rebinding) are refused", async () => {
    process.env.RUNI_DATA_DIR = mkdtempSync(join(tmpdir(), "runi-sec-"));
    process.env.RUNI_SETUP_PORT = "0";
    const setup = new SetupServer({ verifyReichman: async () => ({ ok: false }), verifyPiazza: async () => ({ ok: false }), onChange() {} });
    servers.push(setup);
    const url = new URL(await setup.start());
    const status = await new Promise<number>((resolve) => {
      httpRequest({ host: "127.0.0.1", port: url.port, path: url.pathname + url.search, headers: { Host: `evil.example:${url.port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).end();
    });
    expect(status).toBe(421);
  });
});
