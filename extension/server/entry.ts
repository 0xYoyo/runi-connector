/**
 * Entry point for the Claude Desktop extension (.mcpb) and other local MCP hosts.
 *
 * The host passes the student's Reichman username and password as environment variables
 * (in Claude Desktop they come from the extension settings, where the password is marked
 * sensitive and stored by the OS). This process:
 *   1. signs in to Moodle (current academic year, detected automatically),
 *   2. serves the MCP tools over stdio,
 *   3. signs in again automatically if Moodle says the token expired,
 *   4. downloads syllabi on demand and caches their text locally.
 *
 * The password stays in this process's memory. It is never written to disk or logged.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Browser } from "../../src/browser";
import { MoodleClient, type MoodleCourse } from "../../src/moodle";
import { MichlolClient } from "../../src/michlol";
import { PanoptoClient, srtToText } from "../../src/panopto";
import { PiazzaClient } from "../../src/piazza";
import { signInToMoodle, type Credentials } from "../../src/reichman-login";
import { DEFAULT_SYLLABUS_URL, harvestSyllabi } from "../../src/syllabi";
import { buildServer, type MichlolLike, type PanoptoLike, type PiazzaLike, type UserProps } from "../../src/tools";

import { moodleBaseCandidates } from "./entry-year";

const log = (...parts: unknown[]) => console.error("[reichman]", ...parts); // stdout is the MCP channel

function dataDir(): string {
  const base =
    platform() === "win32"
      ? process.env.APPDATA || join(homedir(), "AppData", "Roaming")
      : platform() === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "runi-connector");
}

// File-backed cache for syllabus text, matching the KVNamespace shape the shared code expects.
function fileCache(): KVNamespace {
  const dir = dataDir();
  const path = join(dir, "syllabi.json");
  let data: Record<string, string> = {};
  try {
    if (existsSync(path)) data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    data = {}; // corrupted cache: start fresh
  }
  return {
    async get(key: string, type?: "text" | "json") {
      const value = data[key];
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      data[key] = value;
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
    },
  } as unknown as KVNamespace;
}

interface Session {
  props: UserProps;
  browser: Browser; // still holds the signed-in web session (used for syllabi)
  signedInAt: number;
}

async function signIn(credentials: Credentials): Promise<Session> {
  let lastError: unknown;
  for (const base of moodleBaseCandidates()) {
    try {
      const { moodleToken, browser } = await signInToMoodle(base, credentials);
      const site = await new MoodleClient(base, moodleToken).siteInfo();
      return {
        props: { moodleToken, moodleBase: base, userId: site.userid, fullName: site.fullname },
        browser,
        signedInAt: Date.now(),
      };
    } catch (error) {
      lastError = error;
      // Wrong password won't get better with an older year; stop early.
      if ((error as { code?: string }).code === "bad_credentials") break;
    }
  }
  throw lastError;
}

async function main() {
  const username = (process.env.RUNI_USERNAME || "").trim();
  const password = process.env.RUNI_PASSWORD || "";
  if (!username || !password) {
    log("Missing username or password. Open the extension's settings and fill them in.");
    process.exit(1);
  }
  const credentials: Credentials = { username, password };

  let session: Session;
  try {
    session = await signIn(credentials);
  } catch (error) {
    log("Sign-in failed:", (error as Error).message);
    process.exit(1);
    return;
  }
  log(`signed in as ${session.props.fullName} (${session.props.moodleBase})`);
  const cache = fileCache();

  const fetchSyllabus = async (course: MoodleCourse) => {
    const attempt = async () =>
      harvestSyllabi(
        cache,
        session.browser,
        session.props.moodleBase,
        [course],
        credentials,
        process.env.SYLLABUS_URL || DEFAULT_SYLLABUS_URL, // override only used by tests
      );
    let report = await attempt();
    // The web session may have gone stale since sign-in; sign in again once and retry.
    if (report.failures.length > 0) {
      log("syllabus fetch failed, signing in again:", report.failures.join("; "));
      session = await signIn(credentials);
      report = await attempt();
    }
    if (report.failures.length > 0) throw new Error(report.failures.join("; "));
  };

  // Lecture recordings + Student Info Station reuse the signed-in web session (via a getter,
  // so they always use the current browser even after a re-login).
  const moodleYear = () => Number(session.props.moodleBase.match(/\/(\d{4})$/)?.[1] ?? new Date().getFullYear());
  const panoptoHost = process.env.PANOPTO_HOST || undefined; // test override
  const michlolHost = process.env.MICHLOL_HOST || undefined; // test override
  const panopto: PanoptoLike = {
    search: (q, n) => new PanoptoClient(session.browser, moodleYear(), panoptoHost).search(q, n),
    transcript: (id) => new PanoptoClient(session.browser, moodleYear(), panoptoHost).transcript(id),
    viewerLink: (id, at) => new PanoptoClient(session.browser, moodleYear(), panoptoHost).viewerLink(id, at),
  };
  const michlol: MichlolLike = {
    grades: (year, sem) => new MichlolClient(session.browser, michlolHost).grades(year, sem),
  };

  // Piazza is a separate account; only expose it when the user supplied Piazza credentials.
  const piazzaEmail = (process.env.PIAZZA_EMAIL || "").trim();
  const piazzaPassword = process.env.PIAZZA_PASSWORD || "";
  let piazzaClient: PiazzaClient | undefined;
  const piazza: PiazzaLike = {
    configured: Boolean(piazzaEmail && piazzaPassword),
    async classes() {
      return (await piazzaReady()).classes();
    },
    async findClass(q) {
      return (await piazzaReady()).findClass(q);
    },
    async search(id, q) {
      return (await piazzaReady()).search(id, q);
    },
    async post(id, n) {
      return (await piazzaReady()).post(id, n);
    },
  };
  async function piazzaReady(): Promise<PiazzaClient> {
    if (!piazzaClient) {
      piazzaClient = new PiazzaClient(new Browser());
      await piazzaClient.login(piazzaEmail, piazzaPassword);
    }
    return piazzaClient;
  }

  const server = buildServer(session.props, cache, {
    onSessionExpired: async () => {
      log("token expired; signing in again");
      session = await signIn(credentials);
      return session.props;
    },
    fetchSyllabus,
    panopto,
    michlol,
    piazza,
    srtToText,
  });

  server.registerTool(
    "forget_my_data",
    {
      title: "Delete my locally saved data",
      description:
        "Deletes the course data this connector saved on this computer (cached syllabi). To also remove your saved username and password, uninstall the extension in Claude Desktop → Settings → Extensions.",
      inputSchema: { confirm: z.boolean().describe("Must be true; ask the user first.") },
      annotations: { destructiveHint: true, readOnlyHint: false, openWorldHint: false },
    },
    async ({ confirm }: { confirm: boolean }) => {
      if (!confirm) {
        return { content: [{ type: "text" as const, text: "Nothing deleted. Ask the user to confirm first." }] };
      }
      rmSync(dataDir(), { recursive: true, force: true });
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Deleted ${dataDir()}. Your saved username and password are kept by the app itself; ` +
              "to remove them, uninstall the extension (Claude Desktop → Settings → Extensions).",
          },
        ],
      };
    },
  );

  await server.connect(new StdioServerTransport());
  log("ready");
}

main().catch((error) => {
  log("fatal:", (error as Error).message);
  process.exit(1);
});
