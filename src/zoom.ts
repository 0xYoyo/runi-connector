// Zoom meetings from a course's "Zoom" activity in Moodle. That activity opens Zoom's LTI app
// (applications.zoom.us/lti/rich), a JavaScript page that lists meetings through its own API
// (read from the app's public script, 2026-10-19):
//   GET /api/v1/lti/rich/meeting/{upComing|history}/COURSE/all?page=1&total=0&lti_scid=<scid>
// where scid comes from the page (window.appConf.page.scid), and the XSRF-TOKEN cookie is sent
// back as the X-XSRF-TOKEN header (axios defaults). Read-only.

import type { Browser } from "./browser";
import { testMode } from "./test-mode";

export interface ZoomMeeting {
  topic: string;
  when: string;
  joinUrl: string | null;
  meetingNumber: string | null;
}

export interface ZoomMeetings {
  upcoming: ZoomMeeting[];
  previous: ZoomMeeting[];
  /** Field names of an item, when the reply had a shape we didn't recognise (no values). */
  unrecognised?: string;
}

const pick = (o: Record<string, unknown>, names: string[]) => {
  for (const n of names) if (o[n] !== undefined && o[n] !== null && o[n] !== "") return o[n];
  return undefined;
};

// The first array of objects anywhere in the reply (Zoom wraps lists as result.list or similar).
function findList(value: unknown, depth = 0): Array<Record<string, unknown>> | null {
  if (depth > 4 || !value || typeof value !== "object") return null;
  if (Array.isArray(value)) return value.length && typeof value[0] === "object" ? (value as Array<Record<string, unknown>>) : value.length === 0 ? [] : null;
  for (const v of Object.values(value)) {
    const found = findList(v, depth + 1);
    if (found) return found;
  }
  return null;
}

function toMeeting(item: Record<string, unknown>): ZoomMeeting {
  const number = pick(item, ["meetingNumber", "meetingId", "meeting_id", "number", "id"]);
  const url = pick(item, ["joinUrl", "join_url", "joinURL", "meetingUrl", "url"]);
  const when = pick(item, ["startTimeStr", "startTimeDisplay", "startTime", "start_time", "time", "startDate"]);
  const duration = pick(item, ["duration"]);
  return {
    topic: String(pick(item, ["topic", "title", "meetingTopic", "name"]) ?? "(untitled)"),
    when: `${when ?? ""}${duration ? ` (${duration} min)` : ""}`.trim(),
    joinUrl: typeof url === "string" && /^https:\/\/[\w.-]*zoom\.us\//.test(url) ? url : number ? `https://zoom.us/j/${String(number).replace(/\D/g, "")}` : null,
    meetingNumber: number ? String(number) : null,
  };
}

export async function zoomMeetings(browser: Browser, page: { url: string; html: string }): Promise<ZoomMeetings> {
  const pageUrl = new URL(page.url);
  if (!/(^|\.)zoom\.us$/.test(pageUrl.hostname) && !(testMode() && pageUrl.hostname === "127.0.0.1")) {
    throw new Error(`the Zoom activity opened ${pageUrl.host}, not Zoom`);
  }
  const scid = page.html.match(/["']?scid["']?\s*:\s*["']([^"']+)["']/)?.[1];
  if (!scid) throw new Error("the Zoom page had no session id (scid)");
  // Read fresh each call: Zoom may set (or rotate) the token cookie on its API replies.
  const xsrfFor = (url: URL) =>
    browser.jar
      .headerFor(url)
      .split("; ")
      .find((c) => c.startsWith("XSRF-TOKEN="))
      ?.slice("XSRF-TOKEN=".length);

  const list = async (type: "upComing" | "history") => {
    const url = `${pageUrl.origin}/api/v1/lti/rich/meeting/${type}/COURSE/all?page=1&total=0&lti_scid=${encodeURIComponent(scid)}`;
    const get = async () => {
      const xsrf = xsrfFor(new URL(url));
      const reply = await browser.request(url, {
        referer: page.url,
        headers: {
          Accept: "application/json, text/plain, */*",
          "X-Requested-With": "XMLHttpRequest",
          ...(xsrf ? { "X-XSRF-TOKEN": decodeURIComponent(xsrf) } : {}),
        },
      });
      try {
        return JSON.parse(reply.text()) as unknown;
      } catch {
        throw new Error(`Zoom's meeting list answered HTTP ${reply.status} without data`);
      }
    };
    let data = await get();
    // A CSRF refusal on the first call usually just set the token cookie: try once more with it.
    if ((data as { errorCode?: unknown } | null)?.errorCode === "csrf") data = await get();
    const items = findList(data);
    return { items, data };
  };

  const upcoming = await list("upComing");
  const previous = await list("history").catch(() => ({ items: [] as Array<Record<string, unknown>>, data: null }));
  const result: ZoomMeetings = {
    upcoming: (upcoming.items ?? []).map(toMeeting),
    previous: (previous.items ?? []).slice(0, 5).map(toMeeting),
  };
  const err = upcoming.data as { status?: unknown; errorCode?: unknown; errorMessage?: unknown; code?: unknown } | null;
  if (err && err.status === false) {
    // Zoom said no: report its own error code and message (no session data).
    // Cookie names only (never values), to see which token Zoom expects.
    const names = browser.jar.headerFor(pageUrl).split("; ").map((c) => c.split("=")[0]).filter(Boolean).join(",");
    result.unrecognised = `Zoom error ${String(err.errorCode ?? err.code ?? "?")}: ${String(err.errorMessage ?? "").slice(0, 200)} (cookies: ${names || "none"})`;
    return result;
  }
  if (!upcoming.items) {
    // Unknown shape: report the keys (never values) so the parser can be fixed.
    const keys = (v: unknown, d = 0): string =>
      v && typeof v === "object" && d < 3 ? `{${Object.entries(v).map(([k, x]) => `${k}${typeof x === "object" ? ":" + keys(x, d + 1) : ""}`).join(",")}}` : "";
    result.unrecognised = keys(upcoming.data);
  }
  return result;
}
