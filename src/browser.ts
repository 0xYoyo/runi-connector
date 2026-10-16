// A tiny "headless browser" that works in Cloudflare Workers and in Node 18+.
// It keeps cookies, follows redirects by hand (so we can see every Location header,
// including the final moodlemobile:// one), and can read and submit HTML forms.

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

interface StoredCookie {
  name: string;
  value: string;
  domain: string; // host the cookie applies to (we treat Domain= as "this host and subdomains")
  path: string;
  hostOnly: boolean;
}

export class CookieJar {
  private cookies: StoredCookie[] = [];

  store(url: URL, setCookieHeaders: string[]) {
    for (const header of setCookieHeaders) {
      const parts = header.split(";").map((p) => p.trim());
      const [nameValue, ...attributes] = parts;
      const eq = nameValue.indexOf("=");
      if (eq <= 0) continue;
      const name = nameValue.slice(0, eq);
      const value = nameValue.slice(eq + 1);

      let domain = url.hostname;
      let hostOnly = true;
      let path = "/";
      let expired = false;
      for (const attribute of attributes) {
        const [key, ...rest] = attribute.split("=");
        const attrValue = rest.join("=");
        const lower = key.toLowerCase();
        if (lower === "domain" && attrValue) {
          domain = attrValue.replace(/^\./, "").toLowerCase();
          hostOnly = false;
        } else if (lower === "path" && attrValue) {
          path = attrValue;
        } else if (lower === "max-age" && Number(attrValue) <= 0) {
          expired = true;
        } else if (lower === "expires" && Date.parse(attrValue) < Date.now()) {
          expired = true;
        }
      }

      this.cookies = this.cookies.filter(
        (c) => !(c.name === name && c.domain === domain && c.path === path),
      );
      if (!expired) {
        this.cookies.push({ name, value, domain, path, hostOnly });
      }
    }
  }

  headerFor(url: URL): string {
    const host = url.hostname.toLowerCase();
    return this.cookies
      .filter((c) => {
        const domainMatches = c.hostOnly
          ? host === c.domain
          : host === c.domain || host.endsWith("." + c.domain);
        return domainMatches && url.pathname.startsWith(c.path);
      })
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }
}

export interface HtmlForm {
  action: string; // absolute URL
  method: string; // "GET" or "POST"
  fields: Record<string, string>;
  inputs: { name: string; type: string; value: string; checked?: boolean }[];
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function readAttribute(tag: string, attribute: string): string | null {
  const pattern = new RegExp(`\\s${attribute}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = tag.match(pattern);
  if (!match) return null;
  return decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
}

// Finds every <form> on the page with its inputs. Good enough for login pages and
// SAML auto-post pages, which are simple by design.
export function parseForms(html: string, pageUrl: string): HtmlForm[] {
  const forms: HtmlForm[] = [];
  const formPattern = /<form\b[^>]*>[\s\S]*?<\/form>/gi;
  for (const match of html.matchAll(formPattern)) {
    const formHtml = match[0];
    const openTag = formHtml.match(/<form\b[^>]*>/i)![0];
    const action = readAttribute(openTag, "action") || pageUrl;
    const method = (readAttribute(openTag, "method") || "GET").toUpperCase();

    const inputs: HtmlForm["inputs"] = [];
    for (const inputMatch of formHtml.matchAll(/<input\b[^>]*>/gi)) {
      const tag = inputMatch[0];
      const name = readAttribute(tag, "name");
      if (!name) continue;
      inputs.push({
        name,
        type: (readAttribute(tag, "type") || "text").toLowerCase(),
        value: readAttribute(tag, "value") || "",
        checked: /\schecked(\s|=|>|\/)/i.test(tag),
      });
    }
    for (const textareaMatch of formHtml.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
      const name = readAttribute(textareaMatch[0], "name");
      if (name) inputs.push({ name, type: "textarea", value: decodeEntities(textareaMatch[2]) });
    }
    for (const selectMatch of formHtml.matchAll(/<select\b[^>]*>[\s\S]*?<\/select>/gi)) {
      const name = readAttribute(selectMatch[0], "name");
      if (!name) continue;
      const options = [...selectMatch[0].matchAll(/<option\b[^>]*>/gi)].map((o) => o[0]);
      const chosen = options.find((o) => /\sselected/i.test(o)) ?? options[0];
      inputs.push({ name, type: "select", value: chosen ? readAttribute(chosen, "value") || "" : "" });
    }

    const fields: Record<string, string> = {};
    for (const input of inputs) {
      if (["submit", "button", "image", "reset"].includes(input.type)) continue;
      if ((input.type === "checkbox" || input.type === "radio") && !input.checked) {
        continue;
      }
      fields[input.name] = input.value;
    }

    forms.push({
      action: new URL(action, pageUrl).toString(),
      method,
      fields,
      inputs,
    });
  }
  return forms;
}

export interface Page {
  url: string; // final URL after redirects
  status: number;
  contentType: string;
  body: ArrayBuffer;
  text(): string;
  // Set when a redirect pointed at a non-http(s) scheme (e.g. moodlemobile://token=...)
  customSchemeRedirect?: string;
}

export interface TraceEntry {
  method: string;
  host: string;
  path: string;
  status: number;
}

export class Browser {
  readonly jar = new CookieJar();
  readonly trace: TraceEntry[] = [];

  constructor(
    private readonly fetchFn: FetchFn = (input, init) => fetch(input, init),
    private readonly userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  ) {}

  async request(
    url: string,
    init: {
      method?: string;
      body?: URLSearchParams;
      json?: unknown;
      referer?: string;
      headers?: Record<string, string>;
    } = {},
    maxRedirects = 20,
  ): Promise<Page> {
    let currentUrl = url;
    let method = init.method || (init.json !== undefined ? "POST" : "GET");
    let body: string | undefined =
      init.json !== undefined ? JSON.stringify(init.json) : init.body ? init.body.toString() : undefined;
    let contentType: string | undefined =
      init.json !== undefined ? "application/json" : init.body ? "application/x-www-form-urlencoded" : undefined;

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const parsed = new URL(currentUrl);
      const headers: Record<string, string> = {
        "User-Agent": this.userAgent,
        Accept: init.json !== undefined ? "application/json, text/plain, */*" : "text/html,application/xhtml+xml,application/pdf,*/*",
        "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
        ...init.headers,
      };
      const cookie = this.jar.headerFor(parsed);
      if (cookie) headers.Cookie = cookie;
      if (init.referer) headers.Referer = init.referer;
      if (body !== undefined && contentType) headers["Content-Type"] = contentType;

      const response = await this.fetchFn(currentUrl, {
        method,
        headers,
        body,
        redirect: "manual",
      });

      this.jar.store(parsed, getSetCookies(response.headers));
      this.trace.push({ method, host: parsed.host, path: parsed.pathname, status: response.status });

      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(location) && !/^https?:/i.test(location)) {
          return {
            url: currentUrl,
            status: response.status,
            contentType: "",
            body: new ArrayBuffer(0),
            text: () => "",
            customSchemeRedirect: location,
          };
        }
        currentUrl = new URL(location, currentUrl).toString();
        // 301/302/303 turn a POST into a GET, like browsers do.
        if (response.status !== 307 && response.status !== 308) {
          method = "GET";
          body = undefined;
          contentType = undefined;
        }
        continue;
      }

      const buffer = await response.arrayBuffer();
      let decoded: string | null = null;
      return {
        url: currentUrl,
        status: response.status,
        contentType: response.headers.get("content-type") || "",
        body: buffer,
        text: () => (decoded ??= new TextDecoder().decode(buffer)),
      };
    }
    throw new Error(`Too many redirects starting at ${new URL(url).host}`);
  }

  /** POSTs JSON and parses a JSON reply. Throws with a short reason if the reply isn't JSON. */
  async json<T>(url: string, payload: unknown, headers: Record<string, string> = {}): Promise<T> {
    const page = await this.request(url, { json: payload, headers });
    const raw = page.text();
    try {
      return JSON.parse(raw) as T;
    } catch {
      const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim().slice(0, 80) ?? "";
      throw new Error(`Expected data from ${new URL(page.url).host} but got a web page (HTTP ${page.status}${title ? `, "${title}"` : ""}).`);
    }
  }

  /** Returns the value of a cookie the jar holds for a URL, if any. */
  cookie(url: string, name: string): string | undefined {
    const entry = this.jar
      .headerFor(new URL(url))
      .split("; ")
      .find((c) => c.startsWith(`${name}=`));
    return entry?.slice(name.length + 1);
  }

  submit(form: HtmlForm, overrides: Record<string, string> = {}, referer?: string): Promise<Page> {
    const values = new URLSearchParams({ ...form.fields, ...overrides });
    if (form.method === "POST") {
      return this.request(form.action, { method: "POST", body: values, referer });
    }
    const target = new URL(form.action);
    for (const [key, value] of values) target.searchParams.set(key, value);
    return this.request(target.toString(), { referer });
  }
}

function getSetCookies(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetter.getSetCookie === "function") return withGetter.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}
