// A tiny HTTP server, bound to 127.0.0.1 only, that serves the sign-in page and verifies
// each login against the real service before saving it. It is protected by a per-run nonce
// so that other local programs or websites can't drive it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { loadCredentials, saveCredentials, storageName, type StoredCredentials } from "./credentials";
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

export class SetupServer {
  private server?: Server;
  private readonly nonce = randomBytes(16).toString("hex");

  constructor(private readonly handlers: SetupHandlers) {}

  private state(): SetupState {
    const creds = loadCredentials();
    return {
      nonce: this.nonce,
      reichmanConnected: Boolean(creds.reichman),
      reichmanName: null,
      piazzaConnected: Boolean(creds.piazza),
      suggestedUsername: creds.reichman?.username ?? "",
      storageName: storageName(),
    };
  }

  async start(): Promise<string> {
    if (this.server) return this.url();
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return this.url();
  }

  private url(): string {
    const addr = this.server!.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    return `http://127.0.0.1:${port}/?k=${this.nonce}`;
  }

  private send(res: ServerResponse, status: number, body: string, type = "application/json") {
    res.writeHead(status, {
      "Content-Type": type + "; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
    });
    res.end(body);
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/") {
      // The page only renders for someone who opened the real link (carries the nonce).
      if (url.searchParams.get("k") !== this.nonce) return this.send(res, 403, "Forbidden", "text/plain");
      return this.send(res, 200, setupPage(this.state()), "text/html");
    }

    if (req.method === "POST") {
      // Nonce in a custom header: a cross-site form can't set it, so other pages can't post here.
      if (req.headers["x-setup-nonce"] !== this.nonce) return this.send(res, 403, JSON.stringify({ ok: false, error: "Forbidden" }));
      try {
        const body = await readJson(req);
        if (url.pathname === "/verify-reichman") return await this.doReichman(res, body);
        if (url.pathname === "/verify-piazza") return await this.doPiazza(res, body);
      } catch {
        return this.send(res, 400, JSON.stringify({ ok: false, error: "Bad request." }));
      }
    }
    this.send(res, 404, JSON.stringify({ ok: false, error: "Not found" }));
  }

  private async doReichman(res: ServerResponse, body: { username?: string; password?: string }) {
    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");
    if (!username || !password) return this.send(res, 200, JSON.stringify({ ok: false, error: "Enter your username and password." }));
    const result = await this.handlers.verifyReichman(username, password);
    if (result.ok) {
      const creds = loadCredentials();
      saveCredentials({ ...creds, reichman: { username, password } });
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
      saveCredentials({ ...creds, piazza: { email, password } });
      this.handlers.onChange();
    }
    this.send(res, 200, JSON.stringify(result));
  }
}

// Opens a URL in the user's default browser, cross-platform, without shell quoting.
export function openInBrowser(url: string) {
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
