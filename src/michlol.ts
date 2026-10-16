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
import type { Browser, Page } from "./browser";

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
  course: string;
  component: string; // lecture / recitation / final exam
  grade: string; // may be "טרם" (not yet) or a number
  credits: string;
}

export class MichlolClient {
  private authed = false;
  private readonly endpoint: string;
  constructor(
    private readonly browser: Browser,
    private readonly host: string = MICHLOL_HOST,
  ) {
    this.endpoint = `${host}/yedion/fireflyweb.aspx`;
  }

  private async ensureAuth() {
    if (this.authed) return;
    const page = await this.browser.request(`${this.host}/yedion/login.aspx?Type=S`);
    if (/login\.aspx/i.test(new URL(page.url).pathname) && !/fireflyweb/i.test(page.url)) {
      throw new Error("Couldn't reach the Student Info Station (sign-in didn't carry over).");
    }
    this.authed = true;
  }

  private openMenu(id: number): Promise<Page> {
    const body = new URLSearchParams({ PRGNAME: "MenuCall", ARGUMENTS: `-N,-N,-N${id},-A` });
    return this.browser.request(this.endpoint, { method: "POST", body, referer: this.endpoint });
  }

  // Reads the hidden query-form fields from a query page.
  private queryFields(html: string): { TZ: string; Token: string; QueryCode: string } {
    const doc = parse(html);
    const val = (name: string) => doc.querySelector(`input[name=${name}]`)?.getAttribute("value") ?? "";
    return { TZ: val("TZ"), Token: val("Token"), QueryCode: val("QueryCode") };
  }

  async grades(year: number | "all" = "all", semester = 0): Promise<GradeRow[]> {
    await this.ensureAuth();
    const page = await this.openMenu(MENU.grades);
    const { TZ, Token, QueryCode } = this.queryFields(page.text());
    if (!Token) throw new Error("Couldn't open the grades screen.");
    const body = new URLSearchParams({
      PRGNAME: "StudentQueryExecution",
      ARGUMENTS: "TZ,Token,QueryCode,R1C1,R1C2",
      TZ,
      Token,
      QueryCode,
      R1C1: year === "all" ? "-1" : String(year),
      R1C2: String(semester),
    });
    const result = await this.browser.request(this.endpoint, { method: "POST", body, referer: this.endpoint });
    return parseGradeCards(result.text());
  }

  // Opens a Michlol page by menu id and returns its readable text. If the page is a
  // year/semester query screen, it runs the query for the chosen year first. Robust for pages
  // whose exact layout we don't parse field-by-field (schedule, exams): the model reads the text.
  async pageText(menuId: number, year: number | "all" = "all", semester = 0): Promise<string> {
    await this.ensureAuth();
    const page = await this.openMenu(menuId);
    let html = page.text();
    const { TZ, Token, QueryCode } = this.queryFields(html);
    const hasQueryForm = Boolean(Token) && /R1C1/.test(html) && /בחירת שנה|select year/i.test(html);
    if (hasQueryForm) {
      const body = new URLSearchParams({
        PRGNAME: "StudentQueryExecution",
        ARGUMENTS: "TZ,Token,QueryCode,R1C1,R1C2",
        TZ,
        Token,
        QueryCode,
        R1C1: year === "all" ? "-1" : String(year),
        R1C2: String(semester),
      });
      html = (await this.browser.request(this.endpoint, { method: "POST", body, referer: this.endpoint })).text();
    }
    return michlolText(html);
  }

  examSchedule(year: number | "all" = "all", semester = 0) {
    return this.pageText(MENU.exams, year, semester);
  }
  weeklySchedule(year: number | "all" = "all", semester = 0) {
    return this.pageText(MENU.scheduleBoard, year, semester);
  }

  // Opens the contact-admin page and returns the recipient and topic options plus the form token,
  // so the tool layer can show the user exactly what will be sent before confirming.
  async contactAdminForm(): Promise<{ recipients: string[]; token: string }> {
    await this.ensureAuth();
    const page = await this.openMenu(MENU.contactAdmin);
    const doc = parse(page.text());
    const recipients = doc
      .querySelectorAll("select[name=R1C5] option")
      .map((o) => o.text.trim())
      .filter(Boolean);
    const token = doc.querySelector("input[name=Token]")?.getAttribute("value") ?? "";
    return { recipients, token };
  }
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

export function parseGradeCards(html: string): GradeRow[] {
  const doc = parse(html);
  const rows: GradeRow[] = [];
  for (const card of doc.querySelectorAll(".Box_ph")) {
    const course = card.querySelector("h2.pagetitle")?.text.trim() ?? "";
    if (!course) continue;
    const ranges = card.querySelectorAll(".InRange").map((e: HTMLElement) => e.text.trim());
    const gradeLine = card.querySelectorAll("strong").map((e) => e.text.trim()).find((t) => t.includes("ציון"));
    rows.push({
      course,
      component: ranges[1] ?? "",
      credits: ranges[0] ?? "",
      grade: gradeLine ? gradeLine.replace(/^ציון:\s*/, "") : "",
    });
  }
  return rows;
}
