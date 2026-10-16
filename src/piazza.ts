// Piazza client. Piazza is a SEPARATE account (no Reichman SSO), so it needs its own email
// and password, supplied as optional settings. Its web app talks to a JSON-RPC API; this
// mirrors the public endpoints the piazza-api community library uses.
//
// Sign-in matches the live site (checked 2026-10-16): the /account/login page has a regular form
// (#login-form: from, email, password, remember, csrf_token) that posts to /class; API calls go
// to /logic/api?method=… as JSON with a CSRF-Token header taken from /main/csrf_token.
// Read-only: list classes, read the feed, read a post, search.

import { parseForms, type Browser } from "./browser";
import { testMode } from "./test-mode";

export const PIAZZA_HOST = "https://piazza.com";

interface RpcResponse<T> {
  result?: T;
  error?: string | { message?: string };
}

export interface PiazzaClass {
  id: string;
  name: string;
  num: string; // course number, e.g. "3030"
  term: string;
}

export interface PiazzaPost {
  id: string;
  number: number;
  subject: string;
  content: string;
  type: string;
  tags: string[];
}

function stripHtml(html = ""): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export class PiazzaError extends Error {}
export class PiazzaAuthError extends PiazzaError {}

export class PiazzaClient {
  private loggedIn = false;
  private csrf = "";
  private readonly logicApi: string;
  private readonly mainApi: string;
  constructor(
    private readonly browser: Browser,
    private readonly base: string = PIAZZA_HOST,
  ) {
    this.logicApi = `${base}/logic/api`;
    this.mainApi = `${base}/main/api`;
  }

  private async rpc<T>(endpoint: string, method: string, params: unknown): Promise<T> {
    const res = await this.browser.json<RpcResponse<T>>(`${endpoint}?method=${encodeURIComponent(method)}`, { method, params }, { "CSRF-Token": this.csrf });
    if (res.error) {
      const message = typeof res.error === "string" ? res.error : res.error.message || "Piazza error";
      if (/log ?in|auth|session|csrf/i.test(message)) throw new PiazzaAuthError(message);
      throw new PiazzaError(message);
    }
    if (res.result === undefined) throw new PiazzaError(`No result from ${method}`);
    return res.result;
  }

  private async refreshCsrf(fallback: string) {
    const page = await this.browser.request(`${this.base}/main/csrf_token`);
    const text = page.text();
    this.csrf = text.match(/CSRF_TOKEN\s*=\s*["']([^"']+)["']/)?.[1] ?? text.match(/["']([A-Za-z0-9._\-+/=]{8,})["']/)?.[1] ?? fallback;
  }

  async login(email: string, password: string): Promise<void> {
    this.loggedIn = false;
    const page = await this.browser.request(`${this.base}/account/login`);
    const form = parseForms(page.text(), page.url).find((f) => f.inputs.some((i) => i.type === "password"));
    if (!form) throw new PiazzaError("Piazza's sign-in page didn't load as expected. Try again later.");
    // The Piazza password only ever goes to Piazza itself, over HTTPS, as a POST.
    const origin = new URL(this.base).origin;
    const secure = new URL(this.base).protocol === "https:" || testMode();
    if (new URL(page.url).origin !== origin || new URL(form.action).origin !== origin || form.method !== "POST" || !secure) {
      throw new PiazzaError("Piazza's sign-in page isn't where it should be, so the password wasn't sent.");
    }
    const passwordField = form.inputs.find((i) => i.type === "password")!.name;
    const emailField = form.inputs.find((i) => /mail/i.test(i.name))?.name ?? "email";
    const result = await this.browser.submit(form, { [emailField]: email, [passwordField]: password, remember: "on" }, page.url);
    const html = result.text();
    const stillOnLogin = parseForms(html, result.url).some((f) => f.inputs.some((i) => i.type === "password"));
    if (/ERROR_MSG\s*=\s*["'][^"']+["']/.test(html) || (stillOnLogin && /account\/login|login-form/i.test(html))) {
      throw new PiazzaAuthError("Piazza didn't accept that email and password.");
    }
    await this.refreshCsrf(form.fields.csrf_token ?? "");
    // Confirm we're really signed in.
    try {
      await this.status();
    } catch {
      throw new PiazzaAuthError("Piazza didn't accept that email and password.");
    }
    this.loggedIn = true;
  }

  private status() {
    type Status = { networks?: Array<{ id: string; name: string; course_number?: string; term?: string }> };
    return this.rpc<Status>(this.logicApi, "user.status", {}).catch(() => this.rpc<Status>(this.mainApi, "user.status", {}));
  }

  private ensure() {
    if (!this.loggedIn) throw new PiazzaAuthError("Not signed in to Piazza.");
  }

  async classes(): Promise<PiazzaClass[]> {
    this.ensure();
    const user = await this.status();
    const nets = user?.networks ?? [];
    return nets.map((n) => ({ id: n.id, name: n.name, num: n.course_number ?? "", term: n.term ?? "" }));
  }

  // Finds a class by course number (e.g. "3030") or part of the name.
  async findClass(query: string): Promise<PiazzaClass | undefined> {
    const q = query.trim().toLowerCase();
    const all = await this.classes();
    return all.find((c) => c.num === q) ?? all.find((c) => c.name.toLowerCase().includes(q));
  }

  async feed(classId: string, limit = 25): Promise<PiazzaPost[]> {
    this.ensure();
    const data = await this.rpc<{ feed: Array<{ id: string; nr: number; subject: string; type: string; tags?: string[] }> }>(
      this.logicApi,
      "network.get_my_feed",
      { nid: classId, limit, offset: 0 },
    );
    return (data.feed ?? []).map((f) => ({
      id: f.id,
      number: f.nr,
      subject: stripHtml(f.subject),
      content: "",
      type: f.type,
      tags: f.tags ?? [],
    }));
  }

  async post(classId: string, postNumber: number): Promise<PiazzaPost> {
    this.ensure();
    const p = await this.rpc<{
      id: string;
      nr: number;
      history: Array<{ subject: string; content: string }>;
      type: string;
      tags?: string[];
    }>(this.logicApi, "content.get", { nid: classId, cid: String(postNumber) });
    const latest = p.history?.[0] ?? { subject: "", content: "" };
    return {
      id: p.id,
      number: p.nr,
      subject: stripHtml(latest.subject),
      content: stripHtml(latest.content),
      type: p.type,
      tags: p.tags ?? [],
    };
  }

  async search(classId: string, query: string): Promise<PiazzaPost[]> {
    this.ensure();
    const results = await this.rpc<Array<{ id: string; nr: number; subject: string; type: string }>>(
      this.logicApi,
      "network.search",
      { nid: classId, query },
    );
    return (results ?? []).map((r) => ({
      id: r.id,
      number: r.nr,
      subject: stripHtml(r.subject),
      content: "",
      type: r.type,
      tags: [],
    }));
  }
}
