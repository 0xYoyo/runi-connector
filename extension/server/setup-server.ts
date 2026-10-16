// A tiny HTTP server, bound to 127.0.0.1 only, that serves the sign-in page and verifies
// each login against the real service before saving it. It is protected by a per-run nonce
// so that other local programs or websites can't drive it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, loadCredentials, saveCredentials, storageName, type StoredCredentials } from "./credentials";
import { setupPage, type SetupState } from "./setup-page";

export interface VerifyResult {
  ok: boolean;
  name?: string;
  error?: string;
}

export interface SetupHandlers {
  verifyReichman(username: string, password: string): Promise<VerifyResult>;
  verifyPiazza(email: string, password: string): Promise<VerifyResult>;
  onChange(): void; // called after credentials are saved, so the running server can pick them up
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    if (chunks.reduce((n, c) => n + c.length, 0) > 1_000_000) throw new Error("too large");
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

const DEFAULT_PORT = 51547;
const APP_ID = "reichman-courses-connector";

// Is the server on this port one of ours (another connector process)?
async function isOurs(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`http://127.0.0.1:${port}/__runi`, { signal: controller.signal }).finally(() => clearTimeout(timer));
    return ((await res.json()) as { app?: string }).app === APP_ID;
  } catch {
    return false;
  }
}

// The nonce is shared by every connector process on this computer (Claude Desktop may start
// several), so the link in an already-open tab keeps working whichever process serves it.
function sharedNonce(): string {
  const path = join(dataDir(), "setup-key");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f]{32}$/.test(existing)) return existing;
  } catch {
    /* create below */
  }
  const fresh = randomBytes(16).toString("hex");
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(path, fresh, { mode: 0o600 });
  return fresh;
}

const MESSAGE_PAGE = (title: string, text: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Arial,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;background:#0f1030;color:#14162e}
main{background:#fff;border-radius:18px;padding:30px;max-width:420px}h1{font-size:21px;margin:0 0 8px}p{color:#5a5f7a;margin:0}</style>
</head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;

export class SetupServer {
  private server?: Server;
  private nonce = "";
  private port = 0;
  private retry?: NodeJS.Timeout;

  constructor(private readonly handlers: SetupHandlers) {}

  private state(): SetupState {
    const creds = loadCredentials();
    return {
      nonce: this.nonce,
      reichmanConnected: Boolean(creds.reichman && !creds.reichmanRejected),
      reichmanName: null,
      piazzaConnected: Boolean(creds.piazza && !creds.piazzaRejected),
      reichmanNotice: creds.reichmanRejected ? "Reichman stopped accepting your saved password. If you changed it, sign in with the new one." : "",
      piazzaNotice: creds.piazzaRejected ? "Piazza stopped accepting your saved password. Sign in again, or skip." : "",
      suggestedUsername: creds.reichman?.username ?? "",
      piazzaEmail: creds.piazza?.email ?? "",
      storageName: storageName(),
    };
  }

  // Serves on a fixed local port. If another connector process already serves it, this one
  // keeps quietly retrying, so it takes over if that process exits. Returns the sign-in URL.
  async start(): Promise<string> {
    if (this.nonce) return this.url();
    this.nonce = sharedNonce();
    const wanted = process.env.RUNI_SETUP_PORT !== undefined ? Number(process.env.RUNI_SETUP_PORT) : DEFAULT_PORT;
    if (await this.listen(wanted)) return this.url();
    if (await isOurs(wanted)) {
      // Another connector process serves the page; take over if it exits.
      this.port = wanted;
      this.retry = setInterval(() => void this.listen(wanted).then((ok) => ok && clearInterval(this.retry)), 2000);
      this.retry.unref();
    } else {
      // Some other app uses that port: serve on any free port instead.
      await this.listen(0);
    }
    return this.url();
  }

  /** Makes sure someone serves the page right now (taking over if the old owner exited). */
  async ensureServing(): Promise<string> {
    await this.start();
    if (this.server || (await isOurs(this.port))) return this.url();
    if (await this.listen(this.port)) {
      clearInterval(this.retry);
      return this.url();
    }
    clearInterval(this.retry);
    await this.listen(0);
    return this.url();
  }

  private listen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createServer((req, res) => void this.handle(req, res));
      server.once("error", () => resolve(false)); // usually EADDRINUSE: another process serves it
      server.listen(port, "127.0.0.1", () => {
        this.server = server;
        server.unref(); // never keep the process alive just for the sign-in page
        const addr = server.address();
        this.port = typeof addr === "object" && addr ? addr.port : port;
        resolve(true);
      });
    });
  }

  get serving(): boolean {
    return Boolean(this.server);
  }

  url(): string {
    return `http://127.0.0.1:${this.port}/?k=${this.nonce}`;
  }

  close() {
    clearInterval(this.retry);
    this.server?.close();
    this.server = undefined;
  }

  private send(res: ServerResponse, status: number, body: string, type = "application/json") {
    res.writeHead(status, {
      "Content-Type": type + "; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
    });
    res.end(body);
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/__runi") return this.send(res, 200, JSON.stringify({ app: APP_ID }));

    if (req.method === "GET" && url.pathname === "/") {
      // The page only renders for someone who opened the real link (carries the nonce).
      if (url.searchParams.get("k") !== this.nonce)
        return this.send(res, 403, MESSAGE_PAGE("This link has expired", "Go back to your chat and ask Claude to connect your Reichman account again."), "text/html");
      return this.send(res, 200, setupPage(this.state()), "text/html");
    }

    if (req.method === "POST") {
      // Nonce in a custom header: a cross-site form can't set it, so other pages can't post here.
      // The body is never echoed back, and nothing here ever redirects to a URL with form fields.
      if (req.headers["x-setup-nonce"] !== this.nonce) {
        req.resume();
        return this.send(res, 403, JSON.stringify({ ok: false, error: "This sign-in page has expired. Ask Claude to connect your account again." }));
      }
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${this.port}`) return this.send(res, 403, JSON.stringify({ ok: false, error: "Forbidden" }));
      try {
        const body = await readJson(req);
        if (url.pathname === "/verify-reichman") return await this.doReichman(res, body);
        if (url.pathname === "/verify-piazza") return await this.doPiazza(res, body);
      } catch {
        return this.send(res, 400, JSON.stringify({ ok: false, error: "Something went wrong. Try again." }));
      }
    }
    req.resume();
    this.send(res, 404, JSON.stringify({ ok: false, error: "Not found" }));
  }

  private async doReichman(res: ServerResponse, body: { username?: string; password?: string }) {
    const username = String(body.username ?? "").trim().replace(/@.*$/, "");
    const password = String(body.password ?? "");
    if (!username || !password) return this.send(res, 200, JSON.stringify({ ok: false, error: "Enter your username and password." }));
    const result = await this.handlers.verifyReichman(username, password);
    if (result.ok) {
      const creds = loadCredentials();
      saveCredentials({ ...creds, reichman: { username, password }, reichmanRejected: false });
      this.handlers.onChange();
    }
    this.send(res, 200, JSON.stringify(result));
  }

  private async doPiazza(res: ServerResponse, body: { email?: string; password?: string }) {
    const email = String(body.email ?? "").trim();
    const password = String(body.password ?? "");
    if (!email || !password) return this.send(res, 200, JSON.stringify({ ok: false, error: "Enter your Piazza email and password." }));
    const result = await this.handlers.verifyPiazza(email, password);
    if (result.ok) {
      const creds = loadCredentials();
      saveCredentials({ ...creds, piazza: { email, password }, piazzaRejected: false });
      this.handlers.onChange();
    }
    this.send(res, 200, JSON.stringify(result));
  }
}

// Opens the sign-in page automatically at most once every few minutes across all connector
// processes, so a host that starts the server several times doesn't open several tabs.
export function openOnce(url: string, windowMs = 5 * 60_000): boolean {
  const marker = join(dataDir(), "setup-opened");
  try {
    const last = Number(readFileSync(marker, "utf8"));
    if (Date.now() - last < windowMs) return false;
  } catch {
    /* never opened */
  }
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(marker, String(Date.now()), { mode: 0o600 });
  } catch {
    /* best effort */
  }
  openInBrowser(url);
  return true;
}

// Opens a URL in the user's default browser, cross-platform, without shell quoting.
export function openInBrowser(url: string) {
  if (process.env.RUNI_NO_BROWSER) return; // tests
  const [cmd, args] =
    platform() === "darwin"
      ? ["open", [url]]
      : platform() === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* the tool result still prints the URL for the user to open manually */
  }
}

export type { StoredCredentials };
