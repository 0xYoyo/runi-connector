import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCredentials } from "../extension/server/credentials";
import { SetupServer } from "../extension/server/setup-server";

let dir: string;
let server: SetupServer;
let url: string;
let nonce: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "runi-setup-"));
  process.env.RUNI_DATA_DIR = dir;
  process.env.RUNI_CREDENTIALS_BACKEND = "file";
  process.env.RUNI_SETUP_PORT = "0";
  server = new SetupServer({
    verifyReichman: async (u, p) => (u === "first.last" && p === "right" ? { ok: true, name: "Yoav" } : { ok: false, error: "nope" }),
    verifyPiazza: async (_e, p) => (p === "right" ? { ok: true } : { ok: false, error: "nope" }),
    onChange: () => {},
  });
  url = await server.start();
  nonce = new URL(url).searchParams.get("k")!;
});

afterEach(() => {
  server.close();
  delete process.env.RUNI_SETUP_PORT;
  delete process.env.RUNI_DATA_DIR;
  delete process.env.RUNI_CREDENTIALS_BACKEND;
});

const origin = () => new URL(url).origin;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(origin() + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("setup server", () => {
  it("serves the page only with the right nonce", async () => {
    expect((await fetch(url)).status).toBe(200);
    expect((await fetch(origin() + "/")).status).toBe(403);
  });

  it("rejects posts without the nonce header (blocks other local sites)", async () => {
    const r = await post("/verify-reichman", { username: "first.last", password: "right" });
    expect(r.status).toBe(403);
    expect(loadCredentials().reichman).toBeUndefined();
  });

  it("rejects wrong credentials and saves nothing", async () => {
    const r = await post("/verify-reichman", { username: "first.last", password: "WRONG" }, { "X-Setup-Nonce": nonce });
    expect(((await r.json()) as { ok: boolean }).ok).toBe(false);
    expect(loadCredentials().reichman).toBeUndefined();
  });

  it("verifies and saves correct credentials to the store", async () => {
    const r = await post("/verify-reichman", { username: "first.last", password: "right" }, { "X-Setup-Nonce": nonce });
    const data = (await r.json()) as { ok: boolean; name?: string };
    expect(data).toEqual({ ok: true, name: "Yoav" });
    expect(loadCredentials().reichman).toEqual({ username: "first.last", password: "right" });
    // stored as hex, not plaintext JSON
    const raw = readFileSync(join(dir, "credentials.hex"), "utf8");
    expect(raw).not.toContain("right");
    expect(/^[0-9a-f]+$/.test(raw.trim())).toBe(true);
  });

  it("saves Piazza alongside Reichman", async () => {
    await post("/verify-reichman", { username: "first.last", password: "right" }, { "X-Setup-Nonce": nonce });
    await post("/verify-piazza", { email: "first.last@post.runi.ac.il", password: "right" }, { "X-Setup-Nonce": nonce });
    const creds = loadCredentials();
    expect(creds.reichman?.username).toBe("first.last");
    expect(creds.piazza?.email).toBe("first.last@post.runi.ac.il");
  });

  it("the page carries no plaintext secrets and loads nothing external", async () => {
    const html = await (await fetch(url)).text();
    expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/); // no external URLs
    expect(html).toContain("Connect your Reichman account");
  });
});
