// Panopto client. Panopto signs in automatically off the Moodle session, so we reuse the
// same Browser that signed in to Moodle. Read-only: list/search recordings and read captions.

import type { Browser } from "./browser";

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
  ) {}

  // Visit the Moodle-provider login once; it sets Panopto cookies from the Moodle session.
  private async ensureAuth() {
    if (this.authed) return;
    await this.browser.request(`${this.host}/Panopto/Pages/Auth/Login.aspx?instance=MoodleProd${this.moodleYear}`);
    this.authed = true;
  }

  async search(query: string, maxResults = 15): Promise<PanoptoSession[]> {
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
