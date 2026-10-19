// Student Info Station ("Michlol", yedion.runi.ac.il) client. It uses the same Reichman
// single sign-on as Moodle, so we reuse the already-signed-in Browser: visiting the Michlol
// login redirects through the identity provider and comes back authenticated.
//
// Pages are driven by POSTs to fireflyweb.aspx. A menu item opens a page with
// PRGNAME=MenuCall & ARGUMENTS=-N,-N,-N<id>,-A. A query page (grades, exams) then carries
// hidden TZ/Token/QueryCode fields and R1C* selects, submitted as PRGNAME=StudentQueryExecution.
//
// Read-only by default. The one write path (contacting the student administration) lives in a
// separate method and the tool layer requires explicit confirmation before calling it.

import { parse, type HTMLElement } from "node-html-parser";
import { parseForms, type Browser, type Page } from "./browser";
import { LoginError, navigateThroughLogin, type Credentials } from "./reichman-login";

export const MICHLOL_HOST = "https://yedion.runi.ac.il";

// Menu item ids seen in the live site (the -N<id> in ARGUMENTS).
export const MENU = {
  grades: 13,
  englishLevel: 102,
  scheduleList: 3,
  scheduleBoard: 16,
  personalCalendar: 21,
  exams: 6,
  examNotebooks: 482,
  contactAdmin: 23,
  messages: 18,
  inquiryTracking: 48,
  finances: 11,
  documents: 7,
} as const;

export interface GradeRow {
  course: string; // "77 אלגוריתמים"
  component: string; // שיעור / תרגול / בוחן …
  sitting: string; // מועד: "1", "2"
  grade: string; // a number, "טרם" (not yet), "פטור" (exempt)…
}

export interface QuerySelection {
  year: string; // label as shown, e.g. 2027 - תשפ"ז
  semester: string;
  years: string[]; // values the page offers
}

export interface MichlolResult<T> {
  data: T;
  selection: QuerySelection;
}

// How each query screen is submitted (read off the live site's own submit, 2026-10-16).
const QUERIES = {
  grades: { menu: 13, prgname: "StudentQueryExecution", args: "TZ,Token,QueryCode,R1C1,R1C2" },
  weeklySchedule: { menu: 16, prgname: "StudentQueryExecution", args: "TZ,Token,QueryCode,R1C1,R1C2" },
  exams: { menu: 6, prgname: "HADPASAT_TOCHNIT_BEHINOT", args: "TZ,Token,R1C1,R1C2,R1C3" },
} as const;

type YearArg = number | "all" | undefined;

interface QueryForm {
  fields: Record<string, string>; // hidden inputs + each select's default
  options: Record<string, Array<{ value: string; label: string }>>;
}

function readQueryForm(html: string): QueryForm {
  const doc = parse(html);
  const fields: Record<string, string> = {};
  const options: QueryForm["options"] = {};
  for (const input of doc.querySelectorAll("input[type=hidden]")) {
    const name = input.getAttribute("name");
    if (name) fields[name] = input.getAttribute("value") ?? "";
  }
  for (const select of doc.querySelectorAll("select")) {
    const name = select.getAttribute("name");
    if (!name) continue;
    const opts = select.querySelectorAll("option").map((o) => ({ value: o.getAttribute("value") ?? "", label: o.text.trim(), selected: o.hasAttribute("selected") }));
    const real = opts.filter((o) => o.value !== "" && !/בחירת/.test(o.value));
    options[name] = real.map(({ value, label }) => ({ value, label }));
    fields[name] = (opts.find((o) => o.selected) ?? real[0])?.value ?? "";
  }
  return { fields, options };
}

// Removes the student's ID number (תעודת זהות) from text we hand to the model; it isn't needed.
export function stripId(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*מ\.ז\b/.test(line))
    .join("\n")
    .replace(/\b\d{9}\b/g, "")
    .replace(/[ \t]+\n/g, "\n");
}

// Pages Michlol / My RUNI show when the session is gone ("logged out", "something went wrong",
// or the My RUNI login form).
const SESSION_LOST = /בוצעה התנתקות|משהו השתבש|להתחברות מחדש|my\.policy|access not found/i;

export class MichlolSessionLost extends Error {}

export class MichlolClient {
  private authed = false;
  private readonly endpoint: string;
  constructor(
    private readonly browser: Browser,
    private readonly host: string = MICHLOL_HOST,
    private readonly credentials?: () => Credentials | undefined,
  ) {
    this.endpoint = `${host}/yedion/fireflyweb.aspx`;
  }

  // Michlol sits behind My RUNI's own gateway, which can ask for the Reichman login again even
  // when Moodle is signed in. Walk that login (Reichman pages only) until Michlol itself loads.
  /** Signs in to the Student Info Station (and with it the My RUNI gateway). */
  ensureSignedIn(): Promise<void> {
    return this.ensureAuth();
  }

  private async ensureAuth() {
    if (this.authed) return;
    const creds = this.credentials?.();
    if (!creds) throw new Error("Not connected to Reichman.");
    const michlolHost = new URL(this.host).host;
    const walk = () =>
      navigateThroughLogin(this.browser, `${this.host}/yedion/login.aspx?Type=S`, creds, (page) => {
        const url = new URL(page.url);
        if (url.host !== michlolHost) return false;
        const html = page.text();
        if (parseForms(html, page.url).some((f) => f.inputs.some((i) => i.type === "password"))) return false;
        return /fireflyweb/i.test(url.pathname) || /fireflyweb\.aspx/i.test(html);
      });
    try {
      await walk();
    } catch (error) {
      // "access not found" from My RUNI's gateway: the session is tied to another service.
      // Start a brand-new session and try once more.
      if (!(error instanceof LoginError) || error.code !== "unexpected_page") throw error;
      this.browser.jar.clear();
      await walk();
    }
    this.authed = true;
  }

  // Runs a Michlol action, signing in first; if the session turns out to be gone, signs in again once.
  private async withSession<T>(action: () => Promise<T>): Promise<T> {
    await this.ensureAuth();
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof MichlolSessionLost)) throw error;
      this.authed = false;
      this.browser.jar.clear(); // a fresh session, not the one that just ended
      await this.ensureAuth();
      return action();
    }
  }

  private async openMenu(id: number): Promise<Page> {
    const body = new URLSearchParams({ PRGNAME: "MenuCall", ARGUMENTS: `-N,-N,-N${id},-A` });
    const page = await this.browser.request(this.endpoint, { method: "POST", body, referer: this.endpoint });
    this.checkSession(page);
    return page;
  }

  private checkSession(page: Page) {
    const url = new URL(page.url);
    if (url.host !== new URL(this.host).host || SESSION_LOST.test(michlolText(page.text()).slice(0, 600))) {
      throw new MichlolSessionLost("The Student Info Station session ended.");
    }
  }

  // Opens a query screen, fills in the year/semester (the page's own defaults unless given),
  // and returns the result page.
  private async runQuery(kind: keyof typeof QUERIES, year: YearArg, semester: number | undefined) {
    const q = QUERIES[kind];
    const page = await this.openMenu(q.menu);
    const form = readQueryForm(page.text());
    if (!form.fields.Token) throw new MichlolSessionLost("The query screen didn't load.");
    const pick = (name: string, wanted: string | undefined) =>
      wanted !== undefined && form.options[name]?.some((o) => o.value === wanted) ? wanted : form.fields[name];
    const values: Record<string, string> = { ...form.fields };
    values.R1C1 = pick("R1C1", year === "all" ? "-1" : year === undefined ? undefined : String(year));
    values.R1C2 = pick("R1C2", semester === undefined ? undefined : String(semester));
    if (kind === "exams") values.R1C3 = form.fields.Terms ?? "0";
    const body = new URLSearchParams({ ...values, PRGNAME: q.prgname, ARGUMENTS: q.args });
    const result = await this.browser.request(this.endpoint, { method: "POST", body, referer: this.endpoint });
    this.checkSession(result);
    const label = (name: string, value: string) => form.options[name]?.find((o) => o.value === value)?.label ?? value;
    const selection: QuerySelection = {
      year: label("R1C1", values.R1C1),
      semester: label("R1C2", values.R1C2),
      years: (form.options.R1C1 ?? []).map((o) => o.value).filter((v) => v !== "-1"),
    };
    return { html: result.text(), selection };
  }

  /** Official grades; defaults to all years. */
  grades(year: YearArg = "all", semester?: number): Promise<MichlolResult<GradeRow[]>> {
    return this.withSession(async () => {
      const { html, selection } = await this.runQuery("grades", year, year === "all" && semester === undefined ? 0 : semester);
      return { data: parseGradeCards(html), selection };
    });
  }

  /** Weekly timetable, one line per class, grouped by day. Defaults to the current semester. */
  weeklySchedule(year?: YearArg, semester?: number): Promise<MichlolResult<string>> {
    return this.withSession(async () => {
      const { html, selection } = await this.runQuery("weeklySchedule", year, semester);
      return { data: parseWeeklyGrid(html) ?? stripId(michlolText(html)), selection };
    });
  }

  /** Exam schedule (all sittings). Defaults to the current semester. */
  examSchedule(year?: YearArg, semester?: number): Promise<MichlolResult<string>> {
    return this.withSession(async () => {
      const { html, selection } = await this.runQuery("exams", year, semester);
      return { data: parseTableGrid(html) ?? stripId(michlolText(html)), selection };
    });
  }

  // Opens the contact-admin page and returns the recipient options plus the form token,
  // so the tool layer can show the user exactly what will be sent before confirming.
  async contactAdminForm(): Promise<{ recipients: string[]; token: string }> {
    const page = await this.withSession(() => this.openMenu(MENU.contactAdmin));
    const doc = parse(page.text());
    const recipients = doc
      .querySelectorAll("select[name=R1C5] option")
      .map((o) => o.text.trim())
      .filter(Boolean);
    const token = doc.querySelector("input[name=Token]")?.getAttribute("value") ?? "";
    return { recipients, token };
  }
}

const clean = (t: string) => t.replace(/\s+/g, " ").trim();

// Michlol lays tables out as Bootstrap rows of .col cells inside .MasterTable .Table.
function gridRows(html: string): string[][] | null {
  const doc = parse(html);
  const box = doc.querySelector(".MasterTable .Table") ?? doc.querySelector(".Table");
  if (!box) return null;
  const rows = box.childNodes
    .filter((n): n is HTMLElement => n instanceof Object && "classList" in n && (n as HTMLElement).classList.contains("row"))
    .map((row) => row.childNodes.filter((c): c is HTMLElement => "classList" in c && /\bcol/.test((c as HTMLElement).getAttribute("class") ?? "")));
  return rows.length > 1 ? rows.map((cells) => cells.map((c) => c.text)) : null;
}

// Weekly timetable grid: first row = days, first column = times. Skips "המשך" (continued) cells.
export function parseWeeklyGrid(html: string): string | null {
  const rows = gridRows(html);
  if (!rows || !rows[0].some((h) => /יום/.test(h))) return null;
  const days = rows[0].map(clean);
  const byDay = new Map<string, string[]>();
  for (const row of rows.slice(1)) {
    row.forEach((cell, i) => {
      if (i === 0 || !days[i]) return;
      // One class per "<course no.>-<name>" chunk; lines inside a class (e.g. its room) stay together.
      for (const entry of cell.split(/\n\s*(?=\d{2,5}-)/).map(clean)) {
        if (!entry || /^המשך/.test(entry)) continue;
        if (!byDay.has(days[i])) byDay.set(days[i], []);
        if (!byDay.get(days[i])!.includes(entry)) byDay.get(days[i])!.push(entry);
      }
    });
  }
  if (byDay.size === 0) return "No classes in this timetable.";
  return days
    .filter((d) => byDay.has(d))
    .map((d) => `${d}:\n${byDay.get(d)!.map((e) => `  - ${e}`).join("\n")}`)
    .join("\n");
}

// Generic table grid: first row = headers; each later row becomes "header: value; …".
export function parseTableGrid(html: string): string | null {
  const rows = gridRows(html);
  if (!rows) return null;
  const headers = rows[0].map(clean);
  const skip = new Set(["בית ספר"]); // truncated school name, no information
  const lines = rows
    .slice(1)
    .map((row) =>
      row
        .map((cell, i) => [headers[i], clean(cell)] as const)
        .filter(([h, v]) => v && h && !skip.has(h))
        .map(([h, v]) => `${h}: ${v}`)
        .join("; "),
    )
    .filter(Boolean);
  return lines.length ? lines.map((l) => `- ${l}`).join("\n") : "Nothing listed for this selection.";
}

// Strips a Michlol page to readable text: drops nav/menu/scripts, keeps the main content.
export function michlolText(html: string): string {
  const doc = parse(html);
  for (const sel of ["script", "style", "nav", "header", "footer", ".menu", "#menu", ".mainmenu"]) {
    doc.querySelectorAll(sel).forEach((el) => el.remove());
  }
  const main = doc.querySelector("#mainContent, main, .maincontent, .content, #region-main") ?? doc.querySelector("body") ?? doc;
  return main.text
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

// Grade cards (.Box_ph). Live layout: .InRange[0] = "77 אלגוריתמים", [1] = "נקודות זכות … / מועד 1",
// [2] = component (שיעור, תרגול…); a <strong> holds "ציון: 95".
export function parseGradeCards(html: string): GradeRow[] {
  const doc = parse(html);
  const rows: GradeRow[] = [];
  for (const card of doc.querySelectorAll(".Box_ph")) {
    const ranges = card.querySelectorAll(".InRange").map((e: HTMLElement) => clean(e.text));
    const course = clean(card.querySelector("h2.pagetitle")?.text ?? "") || ranges[0] || "";
    if (!course) continue;
    const meta = ranges.find((r) => /מועד|נקודות/.test(r)) ?? "";
    const component = (ranges.find((r, i) => i > 0 && r !== meta && r !== course) ?? "").replace(/^[-–\s]+/, "");
    const gradeLine = card.querySelectorAll("strong").map((e) => clean(e.text)).find((t) => t.includes("ציון"));
    rows.push({
      course,
      component,
      sitting: meta.match(/מועד\s*(\d+)/)?.[1] ?? "",
      grade: gradeLine ? gradeLine.replace(/^ציון:\s*/, "") : "",
    });
  }
  return rows;
}
