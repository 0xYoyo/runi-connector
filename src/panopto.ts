// Panopto client. Panopto signs in automatically off the Moodle session, so we reuse the
// same Browser that signed in to Moodle. Read-only: list/search recordings and read captions.

import type { Browser } from "./browser";
import { LoginError, navigateThroughLogin, type Credentials } from "./reichman-login";

export const PANOPTO_HOST = "https://runi.cloud.panopto.eu";

export interface PanoptoSession {
  name: string;
  folder: string;
  durationMin: number;
  startedAt: string | null;
  hasCaptions: boolean;
  viewerUrl: string;
  deliveryId: string;
}

interface RawSession {
  SessionName: string;
  FolderName: string;
  Duration: number;
  StartTime: string | null;
  HasCaptions: boolean;
  ViewerUrl: string;
  DeliveryID: string;
}

function parseMsDate(value: string | null): string | null {
  if (!value) return null;
  const ms = value.match(/\/Date\((\d+)/)?.[1];
  const date = ms ? new Date(Number(ms)) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export class PanoptoClient {
  private authed = false;
  constructor(
    private readonly browser: Browser,
    private readonly moodleYear: number,
    private readonly host: string = PANOPTO_HOST,
    private readonly credentials?: () => Credentials | undefined,
    // Signs in to the My RUNI gateway; used if Panopto's sign-in hits "access not found" first.
    private readonly gatewaySignIn?: () => Promise<void>,
  ) {}

  // Panopto signs in through the My RUNI gateway (SAML): its login page redirects there, and the
  // gateway posts back with an auto-submitting form a plain HTTP client won't follow on its own.
  // Walk that until we're back on a Panopto page that isn't the login page. If the gateway asks
  // for the Reichman password on the way, it's typed only into Reichman pages.
  private async ensureAuth() {
    if (this.authed) return;
    try {
      await this.walkLogin();
    } catch (error) {
      if (!(error instanceof LoginError) || error.code !== "unexpected_page" || !this.gatewaySignIn) throw error;
      await this.gatewaySignIn();
      await this.walkLogin();
    }
    this.authed = true;
  }

  private async walkLogin() {
    const creds = this.credentials?.() ?? { username: "", password: "" };
    const panoptoHost = new URL(this.host).host;
    await navigateThroughLogin(
      this.browser,
      // "IDCPROD" ("RUNI Account") is Panopto's Reichman sign-in. (The MoodleProd{year} providers
      // only work when launched from inside Moodle; checked live 2026-10-16.)
      // `AllowBounce=true` is where Panopto's own page script sends the browser; it answers with a
      // plain HTTP redirect to the gateway, so no script has to run (checked live, signed out).
      `${this.host}/Panopto/Pages/Auth/Login.aspx?instance=IDCPROD&AllowBounce=true`,
      creds,
      (page) => {
        const url = new URL(page.url);
        if (url.host !== panoptoHost || !/^\/Panopto\//i.test(url.pathname)) return false;
        const html = page.text();
        if (/SAMLResponse|onload=["'][^"']*submit/i.test(html)) return false; // still being posted back
        // Signed in: any Panopto page other than login, or the login page showing the signed-in
        // user (seen live: Login.aspx shows "Provider … Sign out" with a __doPostBack form).
        return !/\/Auth\/Login\.aspx$/i.test(url.pathname) || /loginControl\$Logout|Sign out|התנתק/i.test(html);
      },
    );
  }

  // Signs in again on the next call (after the Moodle session was renewed).
  reset() {
    this.authed = false;
  }

  async search(query: string, maxResults = 15): Promise<PanoptoSession[]> {
    const first = await this.searchOnce(query, maxResults);
    if (first.length > 0) return first;
    // Signed out, Panopto returns no results rather than an error; sign in again and retry once.
    this.authed = false;
    return this.searchOnce(query, maxResults);
  }

  private async searchOnce(query: string, maxResults: number): Promise<PanoptoSession[]> {
    await this.ensureAuth();
    const data = await this.browser.json<{ d: { Results: RawSession[] } }>(
      `${this.host}/Panopto/Services/Data.svc/GetSessions`,
      {
        queryParameters: {
          query,
          sortColumn: 1,
          sortAscending: false,
          maxResults,
          page: 0,
          startDate: null,
          endDate: null,
          folderID: null,
          bookmarked: false,
          getFolderData: true,
          isSharedWithMe: false,
          isSubscriptionsPage: false,
          includeArchived: true,
          includeArchivedStateCount: false,
          sessionListOnlyArchived: false,
          includePlaylists: false,
        },
      },
    );
    return (data.d.Results ?? []).map((s) => ({
      name: s.SessionName,
      folder: s.FolderName,
      durationMin: Math.round(s.Duration / 60),
      startedAt: parseMsDate(s.StartTime),
      hasCaptions: s.HasCaptions,
      viewerUrl: s.ViewerUrl || `${this.host}/Panopto/Pages/Viewer.aspx?id=${s.DeliveryID}`,
      deliveryId: s.DeliveryID,
    }));
  }

  // Returns the caption track as SRT text, or null if the recording has none.
  async transcript(deliveryId: string): Promise<string | null> {
    await this.ensureAuth();
    const page = await this.browser.request(
      `${this.host}/Panopto/Pages/Transcription/GenerateSRT.ashx?id=${encodeURIComponent(deliveryId)}&language=0`,
    );
    const text = page.text();
    return page.status === 200 && text.includes("-->") ? text : null;
  }

  viewerLink(deliveryId: string, atSeconds?: number): string {
    const base = `${this.host}/Panopto/Pages/Viewer.aspx?id=${encodeURIComponent(deliveryId)}`;
    return atSeconds ? `${base}&start=${Math.floor(atSeconds)}` : base;
  }
}

// "00:03:12,500 --> …\ntext" → compact "[3:12] text" lines, for feeding transcripts to the model.
export function srtToText(srt: string): string {
  const lines: string[] = [];
  for (const block of srt.split(/\r?\n\r?\n/)) {
    const rows = block.split(/\r?\n/).filter(Boolean);
    const timeRow = rows.find((r) => r.includes("-->"));
    if (!timeRow) continue;
    const start = timeRow.split("-->")[0].trim();
    const [h, m, s] = start.split(/[:,]/).map(Number);
    const stamp = h ? `${h}:${String(m).padStart(2, "0")}:${String(Math.floor(s)).padStart(2, "0")}` : `${m}:${String(Math.floor(s)).padStart(2, "0")}`;
    const spoken = rows.slice(rows.indexOf(timeRow) + 1).join(" ").trim();
    if (spoken) lines.push(`[${stamp}] ${spoken}`);
  }
  return lines.join("\n");
}
