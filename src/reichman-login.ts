// Signs a student in to Reichman's Moodle through the university login page and
// collects a Moodle mobile-app token. The password is only held in memory for the
// duration of this function; nothing here stores it.

import { testMode } from "./test-mode";
import { Browser, isLoopback, parseForms, type FetchFn, type HtmlForm, type Page } from "./browser";

export interface Credentials {
  username: string;
  password: string;
}

export type LoginErrorCode = "bad_credentials" | "mfa_required" | "unexpected_page" | "no_token";

export class LoginError extends Error {
  constructor(
    readonly code: LoginErrorCode,
    message: string,
    readonly afterPassword = false, // a password was already sent; don't retry it elsewhere
  ) {
    super(message);
  }
}

// Only ever type the Reichman password into Reichman's own login pages (and the local test server).
export function isReichmanHost(hostname: string): boolean {
  if (testMode() && isLoopback(hostname)) return true; // the local fake Reichman in tests
  return hostname === "runi.ac.il" || hostname.endsWith(".runi.ac.il");
}

// The password only goes into a Reichman page, over HTTPS, as a POST (never in a URL).
function safeToTypePassword(pageUrl: string, form: HtmlForm): boolean {
  const page = new URL(pageUrl);
  const action = new URL(form.action);
  const secure = (u: URL) => u.protocol === "https:" || (testMode() && isLoopback(u.hostname));
  return form.method === "POST" && isReichmanHost(page.hostname) && isReichmanHost(action.hostname) && secure(page) && secure(action);
}

export interface LoginResult {
  moodleToken: string;
  browser: Browser; // still holds the Moodle and My RUNI session cookies
}

// The text Reichman shows for a wrong username or password ("one or more of the details you
// entered are wrong"), plus common English equivalents.
export const WRONG_DETAILS = /פרטי ההזדהות שמסרת שגויים|שם משתמש או סיסמה שגויים|(username|password|credentials)[^.<]{0,40}(incorrect|invalid|wrong)|(incorrect|invalid|wrong)[^.<]{0,20}(username|password|credentials)/i;

const MFA_FIELD = /otp|passcode|verification|one.?time|2fa|mfa|sms|authcode|token_?code/i;
const USERNAME_FIELD = /user|login|email|mail|uid|name|id/i;

function findPasswordForm(forms: HtmlForm[]): HtmlForm | undefined {
  return forms.find((form) => form.inputs.some((input) => input.type === "password"));
}

function looksLikeMfaForm(forms: HtmlForm[]): boolean {
  return forms.some((form) =>
    form.inputs.some(
      (input) => input.type !== "hidden" && (MFA_FIELD.test(input.name) || input.type === "tel"),
    ),
  );
}

// A page whose only job is to post a SAML message (or similar) onward via JavaScript.
function findAutoPostForm(forms: HtmlForm[]): HtmlForm | undefined {
  return forms.find((form) => {
    const names = form.inputs.map((input) => input.name);
    if (names.some((name) => /^(SAMLResponse|SAMLRequest|RelayState|wresult|wa)$/.test(name))) {
      return true;
    }
    const visible = form.inputs.filter((input) => !["hidden", "submit", "button"].includes(input.type));
    // ASP.NET pages wrap everything in a form of hidden page-state fields; that's not an
    // auto-submitting hand-off, and posting it back just reloads the page (seen live on Panopto).
    const aspNetState = form.inputs.every((input) => /^__|^ctl\d*\$/.test(input.name));
    return form.inputs.length > 0 && visible.length === 0 && !aspNetState;
  });
}

function fillLoginForm(form: HtmlForm, credentials: Credentials): Record<string, string> {
  const password = form.inputs.find((input) => input.type === "password")!;
  const textInputs = form.inputs.filter((input) => ["text", "email", ""].includes(input.type));
  const username =
    textInputs.find((input) => USERNAME_FIELD.test(input.name)) ?? textInputs[0];
  if (!username) {
    throw new LoginError("unexpected_page", "Found a password field but no username field.");
  }
  return { [username.name]: credentials.username, [password.name]: credentials.password };
}

/** True if the page is an LTI/SAML hand-off: a form that only passes a signed message on. */
export function isHandOffPage(html: string): boolean {
  return /<form[^>]*>(?:(?!<\/form>)[\s\S])*?name=["']?(id_token|oauth_signature|lti_message_type|lti_message_hint|login_hint|SAMLResponse)\b/i.test(html);
}

function findMetaOrScriptRedirect(html: string): string | null {
  const meta = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?\d+\s*;\s*url=([^"'>]+)/i);
  if (meta) return meta[1].replace(/&amp;/g, "&");
  const script = html.match(/(?:window\.|document\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i);
  if (script) return script[1];
  return null;
}

function findSamlLoginLink(html: string, pageUrl: string): string | null {
  const link = html.match(/href=["']([^"']*auth\/saml2\/login\.php[^"']*)["']/i);
  return link ? new URL(link[1].replace(/&amp;/g, "&"), pageUrl).toString() : null;
}

function pageTitle(html: string): string {
  return (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim().slice(0, 80);
}

/**
 * Opens `startUrl` and keeps going through login pages, SAML auto-posts and redirects
 * until `isDone` says the page is the one we wanted (or a custom-scheme redirect happens).
 */
export async function navigateThroughLogin(
  browser: Browser,
  startUrl: string,
  credentials: Credentials,
  isDone: (page: Page) => boolean,
  maxSteps = 15,
): Promise<Page> {
  const traceStart = browser.trace.length;
  let page = await browser.request(startUrl);
  let passwordHost: string | null = null; // host we sent the password to, once we have
  const visited: string[] = []; // host+path of each page (no query strings: they can hold tokens)
  // Every HTTP hop of this sign-in, redirects included: method, host+path and status only.
  const route = () =>
    browser.trace
      .slice(traceStart)
      .slice(-12)
      .map((t) => `${t.method} ${t.host}${t.path} ${t.status}`)
      .join(" → ");

  for (let step = 0; step < maxSteps; step++) {
    if (page.customSchemeRedirect || isDone(page)) return page;
    const here = new URL(page.url);
    visited.push(here.host + here.pathname);
    if (visited.filter((v) => v === visited[visited.length - 1]).length > 3) {
      throw new LoginError("unexpected_page", `The login went in circles (${route()}).`, Boolean(passwordHost));
    }

    const html = page.text();
    const forms = parseForms(html, page.url);

    const samlLink = /\/login\/index\.php/.test(new URL(page.url).pathname)
      ? findSamlLoginLink(html, page.url)
      : null;
    if (samlLink) {
      page = await browser.request(samlLink, { referer: page.url });
      continue;
    }

    const host = new URL(page.url).hostname;
    const passwordForm = findPasswordForm(forms);
    if (passwordForm) {
      // Asked for the password again after sending it. Never send it twice (repeated attempts
      // can lock the account). It's only a *wrong* password if Reichman says so; otherwise (e.g.
      // the login page reloaded because two sign-ins overlapped) it's a retryable error.
      if (passwordHost) {
        if (WRONG_DETAILS.test(html)) throw new LoginError("bad_credentials", "The username or password was not accepted.", true);
        throw new LoginError("unexpected_page", `Reichman showed its login page again (${host}, "${pageTitle(html)}"; route: ${route()}).`, true);
      }
      if (!safeToTypePassword(page.url, passwordForm)) {
        throw new LoginError("unexpected_page", `${host} asked for a password, but it isn't a secure Reichman login page, so it wasn't sent.`);
      }
      passwordHost = host;
      page = await browser.submit(passwordForm, fillLoginForm(passwordForm, credentials), page.url);
      continue;
    }

    if (passwordHost && looksLikeMfaForm(forms)) {
      throw new LoginError(
        "mfa_required",
        "The university asked for a second verification step, which this connector can't complete yet.",
      );
    }

    const autoPost = findAutoPostForm(forms);
    if (autoPost) {
      page = await browser.submit(autoPost, {}, page.url);
      continue;
    }

    const redirect = findMetaOrScriptRedirect(html);
    if (redirect) {
      page = await browser.request(new URL(redirect, page.url).toString(), { referer: page.url });
      continue;
    }

    // Reichman's own "wrong details" page (seen live 2026-10-16 with a made-up username: it lands
    // on auth.runi.ac.il/vdesk/hangup.php3, "Reichman University - Logout"). Only this message
    // counts as a wrong password; any other dead end is reported as an error and the saved
    // password is NOT marked as rejected.
    if (passwordHost && WRONG_DETAILS.test(html)) throw new LoginError("bad_credentials", "The username or password was not accepted.", true);
    throw new LoginError(
      "unexpected_page",
      `Stopped at an unexpected page (${new URL(page.url).host}${new URL(page.url).pathname}, "${pageTitle(html)}", HTTP ${page.status}; route: ${route()}).`,
      Boolean(passwordHost),
    );
  }
  throw new LoginError("unexpected_page", `The login flow took too many steps (${route()}).`, Boolean(passwordHost));
}

export function parseMobileTokenRedirect(location: string): string {
  // moodlemobile://token=BASE64("signature:::token[:::privatetoken]")
  const match = location.match(/token=([A-Za-z0-9+/=_-]+)/);
  if (!match) throw new LoginError("no_token", "Moodle did not return a token.");
  const decoded = atob(match[1].replace(/-/g, "+").replace(/_/g, "/"));
  const parts = decoded.split(":::");
  if (parts.length < 2 || !/^[a-f0-9]{32}$/i.test(parts[1])) {
    throw new LoginError("no_token", "Moodle returned a token in an unknown format.");
  }
  return parts[1];
}

export async function signInToMoodle(
  moodleBase: string,
  credentials: Credentials,
  options: { fetchFn?: FetchFn; browser?: Browser } = {},
): Promise<LoginResult> {
  const browser = options.browser ?? new Browser(options.fetchFn);
  const passport = crypto.randomUUID().replace(/-/g, "");
  const launchUrl =
    `${moodleBase}/admin/tool/mobile/launch.php` +
    `?service=moodle_mobile_app&passport=${passport}&urlscheme=moodlemobile`;

  const page = await navigateThroughLogin(browser, launchUrl, credentials, () => false);
  if (!page.customSchemeRedirect) {
    throw new LoginError("no_token", "Signed in, but Moodle did not hand over an app token.");
  }
  return { moodleToken: parseMobileTokenRedirect(page.customSchemeRedirect), browser };
}
