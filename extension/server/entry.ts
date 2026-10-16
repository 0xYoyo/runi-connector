/**
 * Entry point for the Claude Desktop extension (.mcpb) and other local MCP hosts.
 *
 * Sign-in details live in the OS secure store (see credentials.ts), filled in through a local
 * sign-in page (setup-server.ts), not through the host's settings form. On startup:
 *   - if an account is saved, sign in and serve every tool,
 *   - if not, still start (so the tools list appears) and open the sign-in page; tools say
 *     "connect first" until the user signs in, after which they work with no restart.
 *
 * Passwords live only in the OS secure store and this process's memory, and only ever leave
 * to sign in to Reichman (or Piazza). They are never logged.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Browser } from "../../src/browser";
import { MoodleClient, type MoodleCourse } from "../../src/moodle";
import { MichlolClient } from "../../src/michlol";
import { PanoptoClient, srtToText } from "../../src/panopto";
import { PiazzaAuthError, PiazzaClient } from "../../src/piazza";
import { LoginError, signInToMoodle, type Credentials } from "../../src/reichman-login";
import { DEFAULT_SYLLABUS_URL, harvestSyllabi } from "../../src/syllabi";
import { buildServer, type MichlolLike, type PanoptoLike, type PiazzaLike, type UserProps } from "../../src/tools";
import { moodleBaseCandidates } from "./entry-year";
import { clearCredentials, dataDir, loadCredentials } from "./credentials";
import { openInBrowser, openOnce, SetupServer } from "./setup-server";
import { checkForUpdate, updateNotice } from "./updates";

// Read the installed version from the manifest next to this bundle (best-effort).
function currentVersion(): string {
  try {
    return JSON.parse(readFileSync(join(__dirname, "..", "manifest.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const log = (...parts: unknown[]) => console.error("[reichman]", ...parts); // stdout is the MCP channel

// File-backed cache for syllabus text, matching the KVNamespace shape the shared code expects.
function fileCache(): KVNamespace {
  const dir = dataDir();
  const path = join(dir, "syllabi.json");
  let data: Record<string, string> = {};
  try {
    if (existsSync(path)) data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    data = {};
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
  browser: Browser;
}

// Signs in to Moodle, trying the current academic year then the previous one.
async function signIn(credentials: Credentials): Promise<Session> {
  let lastError: unknown;
  for (const base of moodleBaseCandidates()) {
    try {
      const { moodleToken, browser } = await signInToMoodle(base, credentials);
      const site = await new MoodleClient(base, moodleToken).siteInfo();
      return { props: { moodleToken, moodleBase: base, userId: site.userid, fullName: site.fullname }, browser };
    } catch (error) {
      lastError = error;
      if (error instanceof LoginError && error.code === "bad_credentials") break;
    }
  }
  throw lastError;
}

async function main() {
  const cache = fileCache();
  const ref: { session: Session | null } = { session: null };

  // Reichman sign-in, used both to connect at startup and to verify creds from the setup page.
  async function connectReichman(): Promise<UserProps> {
    const creds = loadCredentials().reichman;
    if (!creds) throw new Error("No Reichman account saved. Open the connector's sign-in page first.");
    ref.session = await signIn(creds);
    log(`signed in as ${ref.session!.props.fullName} (${ref.session!.props.moodleBase})`);
    return ref.session!.props;
  }

  const moodleYear = () => Number(ref.session?.props.moodleBase.match(/\/(\d{4})$/)?.[1] ?? new Date().getFullYear());
  const panoptoHost = process.env.PANOPTO_HOST || undefined;
  const michlolHost = process.env.MICHLOL_HOST || undefined;
  const needBrowser = (): Browser => {
    if (!ref.session) throw new Error("Not connected to Reichman.");
    return ref.session.browser;
  };

  const panopto: PanoptoLike = {
    search: (q, n) => new PanoptoClient(needBrowser(), moodleYear(), panoptoHost).search(q, n),
    transcript: (id) => new PanoptoClient(needBrowser(), moodleYear(), panoptoHost).transcript(id),
    viewerLink: (id, at) => new PanoptoClient(needBrowser(), moodleYear(), panoptoHost).viewerLink(id, at),
  };
  const michlol: MichlolLike = {
    grades: (year, sem) => new MichlolClient(needBrowser(), michlolHost).grades(year, sem),
    examSchedule: (year, sem) => new MichlolClient(needBrowser(), michlolHost).examSchedule(year, sem),
    weeklySchedule: (year, sem) => new MichlolClient(needBrowser(), michlolHost).weeklySchedule(year, sem),
  };

  let piazzaClient: PiazzaClient | undefined;
  async function piazzaReady(): Promise<PiazzaClient> {
    const creds = loadCredentials().piazza;
    if (!creds) throw new PiazzaAuthError("Piazza isn't set up.");
    if (!piazzaClient) {
      piazzaClient = new PiazzaClient(new Browser());
      await piazzaClient.login(creds.email, creds.password);
    }
    return piazzaClient;
  }
  const piazza: PiazzaLike = {
    get configured() {
      return Boolean(loadCredentials().piazza);
    },
    classes: async () => (await piazzaReady()).classes(),
    findClass: async (q) => (await piazzaReady()).findClass(q),
    search: async (id, q) => (await piazzaReady()).search(id, q),
    post: async (id, n) => (await piazzaReady()).post(id, n),
  };

  const fetchSyllabus = async (course: MoodleCourse) => {
    const attempt = () =>
      harvestSyllabi(cache, needBrowser(), ref.session!.props.moodleBase, [course], loadCredentials().reichman!, process.env.SYLLABUS_URL || DEFAULT_SYLLABUS_URL);
    let report = await attempt();
    if (report.failures.length > 0) {
      await connectReichman();
      report = await attempt();
    }
    if (report.failures.length > 0) throw new Error(report.failures.join("; "));
  };

  // Local sign-in page: verifies each login against the real service before saving it.
  const setup = new SetupServer({
    verifyReichman: async (username, password) => {
      try {
        ref.session = await signIn({ username, password });
        return { ok: true, name: ref.session!.props.fullName };
      } catch (error) {
        const code = (error as LoginError).code;
        const message =
          code === "bad_credentials"
            ? "Reichman didn't accept that username and password."
            : code === "mfa_required"
              ? "Reichman asked for a second verification step, which isn't supported yet."
              : `Couldn't sign in: ${(error as Error).message}`;
        return { ok: false, error: message };
      }
    },
    verifyPiazza: async (email, password) => {
      try {
        piazzaClient = new PiazzaClient(new Browser());
        await piazzaClient.login(email, password);
        return { ok: true };
      } catch (error) {
        piazzaClient = undefined;
        return { ok: false, error: "Piazza didn't accept that email and password." };
      }
    },
    onChange: () => {
      piazzaClient = undefined; // force re-login with new creds next time
    },
  });
  const setupUrl = await setup.start();

  if (loadCredentials().reichman) {
    try {
      await connectReichman();
    } catch (error) {
      log("startup sign-in failed:", (error as Error).message);
    }
  } else {
    if (openOnce(setupUrl)) log("no account saved; opened the sign-in page");
  }

  const update = await checkForUpdate(currentVersion());
  if (update) log(`update available: v${update.latest} (have v${update.current})`);

  const server = buildServer(ref.session ? ref.session!.props : null, cache, {
    onSessionExpired: connectReichman,
    fetchSyllabus,
    panopto,
    michlol,
    piazza,
    srtToText,
    updateNotice: update ? updateNotice(update) : undefined,
  });

  server.registerTool(
    "connect_account",
    {
      title: "Connect or change your Reichman / Piazza login",
      description:
        "Opens the sign-in page in your browser to connect your Reichman account (and optionally Piazza), or to change or re-enter a login that stopped working. Use this whenever a tool says you're not connected.",
      inputSchema: {},
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async () => {
      await setup.start();
      openInBrowser(setup.url());
      return { content: [{ type: "text" as const, text: `Opened the sign-in page in your browser. If it didn't open, go to: ${setup.url()}\nSign in there, then come back and ask again.` }] };
    },
  );

  server.registerTool(
    "forget_my_data",
    {
      title: "Delete my saved login and data",
      description:
        "Removes your saved Reichman and Piazza logins and the course data cached on this computer. You'll need to sign in again afterward.",
      inputSchema: { confirm: z.boolean().describe("Must be true; ask the user first.") },
      annotations: { destructiveHint: true, readOnlyHint: false, openWorldHint: false },
    },
    async ({ confirm }: { confirm: boolean }) => {
      if (!confirm) return { content: [{ type: "text" as const, text: "Nothing deleted. Ask the user to confirm first." }] };
      clearCredentials();
      rmSync(join(dataDir(), "syllabi.json"), { force: true });
      ref.session = null;
      piazzaClient = undefined;
      return { content: [{ type: "text" as const, text: "Deleted your saved logins and cached course data. Use connect_account to sign in again." }] };
    },
  );

  await server.connect(new StdioServerTransport());
  log("ready");
}

main().catch((error) => {
  log("fatal:", (error as Error).message);
  process.exit(1);
});
