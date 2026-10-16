// Piazza client. Piazza is a SEPARATE account (no Reichman SSO), so it needs its own email
// and password, supplied as optional settings. Its web app talks to a JSON-RPC API; this
// mirrors the public endpoints the piazza-api community library uses.
//
// NOTE: not yet verified against a live Reichman Piazza account. Treat as best-effort until
// tested. Read-only: list classes, read the feed, read a post, search.

import type { Browser } from "./browser";

const BASE = "https://piazza.com";
const API_LOGIC = `${BASE}/logic/api`;
const API_MAIN = `${BASE}/main/api`;

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
  constructor(private readonly browser: Browser) {}

  private async rpc<T>(endpoint: string, method: string, params: unknown): Promise<T> {
    const res = await this.browser.json<RpcResponse<T>>(endpoint, { method, params });
    if (res.error) {
      const message = typeof res.error === "string" ? res.error : res.error.message || "Piazza error";
      if (/login|auth|session/i.test(message)) throw new PiazzaAuthError(message);
      throw new PiazzaError(message);
    }
    if (res.result === undefined) throw new PiazzaError(`No result from ${method}`);
    return res.result;
  }

  async login(email: string, password: string): Promise<void> {
    await this.browser.request(`${BASE}/account/login`); // sets initial cookies
    await this.rpc(API_LOGIC, "user.login", { email, pass: password });
    this.loggedIn = true;
  }

  private ensure() {
    if (!this.loggedIn) throw new PiazzaAuthError("Not signed in to Piazza.");
  }

  async classes(): Promise<PiazzaClass[]> {
    this.ensure();
    const user = await this.rpc<{ networks: Array<{ id: string; name: string; course_number?: string; term?: string }> }>(
      API_MAIN,
      "user.status",
      {},
    ).catch(() => null);
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
      API_LOGIC,
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
    }>(API_LOGIC, "content.get", { nid: classId, cid: String(postNumber) });
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
      API_LOGIC,
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
