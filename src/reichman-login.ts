// Signs a student in to Reichman's Moodle through the university login page and
// collects a Moodle mobile-app token. The password is only held in memory for the
// duration of this function; nothing here stores it.

import { Browser, parseForms, type FetchFn, type HtmlForm, type Page } from "./browser";

export interface Credentials {
  username: string;
  password: string;
}

export type LoginErrorCode = "bad_credentials" | "mfa_required" | "unexpected_page" | "no_token";

export class LoginError extends Error {
  constructor(
    readonly code: LoginErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface LoginResult {
  moodleToken: string;
  browser: Browser; // still holds the Moodle and My RUNI session cookies
}

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
    return form.inputs.length > 0 && visible.length === 0;
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
  let page = await browser.request(startUrl);
  let passwordSubmissions = 0;

  for (let step = 0; step < maxSteps; step++) {
    if (page.customSchemeRedirect || isDone(page)) return page;

    const html = page.text();
    const forms = parseForms(html, page.url);

    const samlLink = /\/login\/index\.php/.test(new URL(page.url).pathname)
      ? findSamlLoginLink(html, page.url)
      : null;
    if (samlLink) {
      page = await browser.request(samlLink, { referer: page.url });
      continue;
    }

    const passwordForm = findPasswordForm(forms);
    if (passwordForm) {
      if (passwordSubmissions >= 2) {
        throw new LoginError("bad_credentials", "The username or password was not accepted.");
      }
      passwordSubmissions++;
      page = await browser.submit(passwordForm, fillLoginForm(passwordForm, credentials), page.url);
      continue;
    }

    if (passwordSubmissions > 0 && looksLikeMfaForm(forms)) {
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

    throw new LoginError(
      "unexpected_page",
      `Stopped at an unexpected page (${new URL(page.url).host}, "${pageTitle(html)}", HTTP ${page.status}).`,
    );
  }
  throw new LoginError("unexpected_page", "The login flow took too many steps.");
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
