// Thin client for Moodle's web-service REST API, using the mobile-app token.

export class MoodleSessionExpired extends Error {
  readonly name = "MoodleSessionExpired";
  constructor() {
    super(
      "Your Reichman Moodle access has expired. Sign in again: run `npm run login` (local version), or reconnect the connector.",
    );
  }
}

export class MoodleError extends Error {
  readonly name = "MoodleError";
}

export interface MoodleCourse {
  id: number;
  fullname: string;
  shortname: string;
  courseNumber?: string;
}

type Params = Record<string, string | number | boolean | Array<string | number>>;

function flatten(params: Params): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => body.set(`${key}[${index}]`, String(item)));
    } else {
      body.set(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
    }
  }
  return body;
}

export class MoodleClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async call<T>(wsfunction: string, params: Params = {}): Promise<T> {
    const body = flatten(params);
    body.set("wstoken", this.token);
    body.set("wsfunction", wsfunction);
    body.set("moodlewsrestformat", "json");

    const response = await this.fetchFn(`${this.baseUrl}/webservice/rest/server.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const raw = await response.text();
    let data: T & { exception?: string; errorcode?: string; message?: string };
    try {
      data = JSON.parse(raw);
    } catch {
      // Not JSON: a login redirect, maintenance page or firewall block. Say which, so it can be fixed.
      const finalUrl = new URL(response.url || this.baseUrl);
      const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim().slice(0, 100) ?? "";
      const detail = `HTTP ${response.status}, ${finalUrl.host}${finalUrl.pathname}${response.redirected ? " (after redirect)" : ""}, title "${title}"`;
      console.warn("moodle non-json response", wsfunction, detail, raw.slice(0, 300).replace(/\s+/g, " "));
      throw new MoodleError(`Moodle sent a web page instead of data (${detail}).`);
    }
    if (!response.ok) throw new MoodleError(`Moodle returned HTTP ${response.status}`);
    if (data && typeof data === "object" && "exception" in data && data.exception) {
      if (data.errorcode === "invalidtoken" || data.errorcode === "accessexception") {
        throw new MoodleSessionExpired();
      }
      throw new MoodleError(`${wsfunction}: ${data.message ?? data.errorcode}`);
    }
    return data;
  }

  siteInfo() {
    return this.call<{ userid: number; fullname: string; sitename: string }>(
      "core_webservice_get_site_info",
    );
  }

  async courses(userId: number): Promise<MoodleCourse[]> {
    const raw = await this.call<Array<{ id: number; fullname: string; shortname: string }>>(
      "core_enrol_get_users_courses",
      { userid: userId },
    );
    return raw.map((course) => ({
      id: course.id,
      fullname: course.fullname,
      shortname: course.shortname,
      // Reichman short names look like "Algorithms-77-2027/1 - 2701328"
      courseNumber: course.shortname.match(/-(\d{2,5})-\d{4}\//)?.[1],
    }));
  }

  // Downloads a file from a Moodle file URL (pluginfile), authenticating with the token.
  async downloadFile(fileUrl: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    const url = new URL(fileUrl);
    if (url.origin !== new URL(this.baseUrl).origin) {
      throw new MoodleError("That file is not on Reichman's Moodle.");
    }
    if (url.pathname.includes("/pluginfile.php") && !url.pathname.includes("/webservice/")) {
      url.pathname = url.pathname.replace("/pluginfile.php", "/webservice/pluginfile.php");
    }
    url.searchParams.set("token", this.token);
    const response = await this.fetchFn(url.toString());
    if (!response.ok) throw new MoodleError(`Could not download the file (HTTP ${response.status}).`);
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    if (contentType.includes("application/json")) {
      const data = (await response.json()) as { errorcode?: string; error?: string };
      if (data.errorcode === "invalidtoken") throw new MoodleSessionExpired();
      throw new MoodleError(data.error ?? "Moodle refused the download.");
    }
    return { bytes: await response.arrayBuffer(), contentType };
  }
}

// Finds a course by Moodle id, course number (e.g. "77"), or part of its name.
export function matchCourse(courses: MoodleCourse[], query: string): MoodleCourse | undefined {
  const q = query.trim().toLowerCase();
  return (
    courses.find((c) => String(c.id) === q) ??
    courses.find((c) => c.courseNumber === q) ??
    courses.find((c) => c.fullname.toLowerCase() === q) ??
    courses.find((c) => c.fullname.toLowerCase().includes(q) || c.shortname.toLowerCase().includes(q))
  );
}
