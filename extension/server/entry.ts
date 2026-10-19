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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { Browser } from "../../src/browser";
import { MoodleClient, type MoodleCourse } from "../../src/moodle";
import { MichlolClient } from "../../src/michlol";
import { PanoptoClient, srtToText } from "../../src/panopto";
import { PiazzaAuthError, PiazzaClient } from "../../src/piazza";
import { LoginError, signInToMoodle, type Credentials } from "../../src/reichman-login";
import { DEFAULT_SYLLABUS_URL, harvestSyllabi } from "../../src/syllabi";
import { buildServer, NotConnectedError, type MichlolLike, type PanoptoLike, type PiazzaLike, type UserProps } from "../../src/tools";
import { moodleBaseCandidates } from "./entry-year";
import { testOverride } from "../../src/test-mode";
import { clearCredentials, dataDir, loadCredentials, saveCredentials } from "./credentials";
import { openInBrowser, openOnce, rotateSetupKey, SetupServer } from "./setup-server";
import { runCli } from "./install";
import { runningVersion } from "./updates";
import { supervise } from "./supervisor";

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
      mkdirSync(dir, { recursive: true, mode: 0o700 });
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
      // Once the password has been sent, never try it again against another year's Moodle.
      if (error instanceof LoginError && (error.code === "bad_credentials" || error.afterPassword)) break;
    }
  }
  throw lastError;
}

const selfUpdate = !process.env.RUNI_NO_SELF_UPDATE;

// Only one connector process signs in to Reichman at a time (Claude Desktop can run several):
// overlapping sign-ins for the same account make Reichman's gateway reload its login page.
async function withSignInLock<T>(run: () => Promise<T>): Promise<T> {
  const path = join(dataDir(), "signin.lock");
  const deadline = Date.now() + 90_000;
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  let held = false;
  while (!held && Date.now() < deadline) {
    try {
      closeSync(openSync(path, "wx", 0o600));
      held = true;
    } catch {
      try {
        if (Date.now() - statSync(path).mtimeMs > 60_000) rmSync(path, { force: true }); // left by a crashed process
      } catch {
        /* gone already */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  try {
    return await run();
  } finally {
    if (held) rmSync(path, { force: true });
  }
}

// Saves a course file under the user's home folder (never anywhere else), keeping the original.
async function saveCourseFile(folder: string | undefined, courseName: string, filename: string, bytes: ArrayBuffer): Promise<string | null> {
  const home = homedir();
  const clean = (part: string) => part.replace(/[\/\\:*?"<>|\x00-\x1f]/g, "-").replace(/^\.+/, "").trim().slice(0, 150) || "file";
  const asked = folder?.trim().replace(/^~(?=$|[\/\\])/, home);
  // "Desktop/Year 2/…" means inside the home folder, not wherever the connector happens to run.
  const target = asked ? (isAbsolute(asked) ? resolvePath(asked) : resolvePath(home, asked)) : join(home, "Downloads", "Reichman", clean(courseName));
  const inside = (p: string, root: string) => p === root || p.startsWith(root + sep);
  if (!inside(target, home)) throw new Error(`can only save inside your home folder (${home}), not ${target}`);
  try {
    mkdirSync(target, { recursive: true });
    // A shortcut (symlink) inside the home folder mustn't lead outside it.
    if (!inside(realpathSync(target), realpathSync(home))) throw new Error(`can only save inside your home folder (${home})`);
    const path = join(target, clean(filename));
    if (existsSync(path) && statSync(path).size === bytes.byteLength) return null;
    writeFileSync(path, Buffer.from(bytes));
    return path;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      throw new Error(
        `not allowed to write to ${target}. On a Mac, allow Claude in System Settings → Privacy & Security → Files and Folders, or pick another folder (e.g. ~/Documents/Reichman).`,
      );
    }
    throw error;
  }
}

async function main() {
  const cache = fileCache();
  const ref: { session: Session | null } = { session: null };

  // The sign-in page (started below, before any tool can run).
  let setup!: SetupServer;
  const signInLink = () => setup.url();

  // A tool needs the user to sign in: open the page (at most once in a while) and say so, with
  // the link, so Claude can show it even if the browser didn't come to the front.
  function needSignIn(reason: string, openWindowMs = 5 * 60_000): NotConnectedError {
    openOnce(signInLink(), openWindowMs);
    return new NotConnectedError(
      `${reason} The sign-in page should have opened in the browser. Show the user this link as a clickable link in case it didn't: ${signInLink()}`,
    );
  }

  // Marks a saved password as rejected, but only if it's still the one we tried (another
  // connector process may have saved a new one in the meantime).
  function markRejected(service: "reichman" | "piazza", tried: { password: string }) {
    const creds = loadCredentials();
    if (creds[service]?.password !== tried.password) return;
    saveCredentials({ ...creds, [service === "reichman" ? "reichmanRejected" : "piazzaRejected"]: true });
    log(`${service} rejected the saved password; waiting for the user to sign in again`);
  }

  const REICHMAN_REJECTED =
    "Reichman stopped accepting the saved password (it was probably changed). To avoid locking the account, the connector won't retry it until the user signs in again.";

  let lastProblem: { at: string; message: string } | null = null;

  // Turns a Reichman login failure into what the user should see; marks a wrong password.
  function reichmanFailure(error: unknown, tried: Credentials): Error {
    lastProblem = { at: new Date().toISOString(), message: (error as Error).message };
    if (error instanceof LoginError && error.code === "bad_credentials") {
      markRejected("reichman", tried);
      return needSignIn(REICHMAN_REJECTED, 6 * 3600_000);
    }
    if (error instanceof LoginError && error.code === "mfa_required") {
      return new Error("Reichman asked for a second verification step, which the connector can't do yet.");
    }
    if (error instanceof LoginError) return new Error(`Signing in to Reichman didn't complete (${error.message}). Try again in a minute. [connector v${runningVersion()}]`);
    return new Error(`Couldn't reach Reichman right now (${(error as Error).message}). Check the internet connection and try again.`);
  }

  // Signs in with the saved login. One sign-in at a time: concurrent callers share it.
  let signingIn: Promise<UserProps> | null = null;
  function connectReichman(): Promise<UserProps> {
    signingIn ??= (async () => {
      const creds = loadCredentials();
      if (!creds.reichman) throw needSignIn("No Reichman account is connected yet.");
      if (creds.reichmanRejected) throw needSignIn(REICHMAN_REJECTED, 6 * 3600_000);
      try {
        ref.session = await withSignInLock(() => signIn(creds.reichman!));
      } catch (error) {
        throw reichmanFailure(error, creds.reichman);
      }
      log(`signed in as ${ref.session!.props.fullName} (${ref.session!.props.moodleBase})`);
      return ref.session!.props;
    })().finally(() => (signingIn = null));
    return signingIn;
  }

  // Reuses the current session if there is one (or one being made), else signs in.
  const ensureReichman = (): Promise<UserProps> => (ref.session ? Promise.resolve(ref.session.props) : connectReichman());

  const piazzaHost = testOverride("PIAZZA_HOST");
  // The academic year (Moodle's base URL ends with it); falls back to the current academic year.
  const moodleYear = () =>
    Number(ref.session?.props.moodleBase.match(/\/(\d{4})$/)?.[1] ?? moodleBaseCandidates()[0].match(/\/(\d{4})$/)?.[1] ?? new Date().getFullYear());
  const panoptoHost = testOverride("PANOPTO_HOST");
  const michlolHost = testOverride("MICHLOL_HOST");
  const needBrowser = (): Browser => {
    if (!ref.session) throw new Error("Not connected to Reichman.");
    return ref.session.browser;
  };

  const reichmanCreds = () => {
    const creds = loadCredentials();
    return creds.reichmanRejected ? undefined : creds.reichman;
  };

  // The Student Info Station has its own gateway session (My RUNI ties a gateway session to the
  // service it was opened for). Panopto signs in through Moodle's session (provider
  // MoodleProd{year}); "RUNI Account" via the gateway is only a fallback (ACL-denied for students).
  let gatewayClients: { panopto: PanoptoClient; michlol: MichlolClient } | null = null;
  const resetGatewayClients = () => (gatewayClients = null);
  const clientsFor = () => {
    if (!gatewayClients) {
      const gatewayBrowser = new Browser();
      const michlolClient = new MichlolClient(gatewayBrowser, michlolHost, reichmanCreds);
      gatewayClients = {
        michlol: michlolClient,
        panopto: new PanoptoClient(
          [
            {
              get instance() {
                return `MoodleProd${moodleYear()}`; // known once Moodle has signed in (before runs first)
              },
              browser: needBrowser,
              before: async () => void (await ensureReichman()),
            },
            { instance: "IDCPROD", browser: () => gatewayBrowser, before: (fresh) => michlolClient.ensureSignedIn(fresh) },
          ],
          moodleYear(),
          panoptoHost,
          reichmanCreds,
        ),
      };
    }
    return gatewayClients;
  };

  // Panopto and Michlol sign in through the My RUNI gateway with the saved login; if that says
  // the password is wrong, handle it like a failed Reichman sign-in.
  async function viaGateway<T>(run: (c: { panopto: PanoptoClient; michlol: MichlolClient }) => Promise<T>): Promise<T> {
    const saved = loadCredentials();
    if (!saved.reichman) throw needSignIn("No Reichman account is connected yet.");
    if (saved.reichmanRejected) throw needSignIn(REICHMAN_REJECTED, 6 * 3600_000);
    const c = clientsFor();
    const tried = saved.reichman;
    try {
      return await withSignInLock(() => run(c));
    } catch (error) {
      if (error instanceof LoginError) throw reichmanFailure(error, tried);
      throw error;
    }
  }

  const panopto: PanoptoLike = {
    search: (q, n) => viaGateway((c) => c.panopto.search(q, n)),
    transcript: (id) => viaGateway((c) => c.panopto.transcript(id)),
    viewerLink: (id, at) => new PanoptoClient(new Browser(), 0, panoptoHost).viewerLink(id, at),
  };
  const michlol: MichlolLike = {
    grades: (year, sem) => viaGateway((c) => c.michlol.grades(year, sem)),
    examSchedule: (year, sem) => viaGateway((c) => c.michlol.examSchedule(year, sem)),
    weeklySchedule: (year, sem) => viaGateway((c) => c.michlol.weeklySchedule(year, sem)),
  };

  let piazzaClient: PiazzaClient | undefined;
  const PIAZZA_REJECTED = "Piazza stopped accepting the saved password (it was probably changed). The connector won't retry it until the user signs in to Piazza again.";
  async function piazzaReady(): Promise<PiazzaClient> {
    const creds = loadCredentials();
    if (!creds.piazza) throw needSignIn("Piazza isn't connected yet (it has its own login).");
    if (creds.piazzaRejected) throw needSignIn(PIAZZA_REJECTED, 6 * 3600_000);
    if (!piazzaClient) {
      const client = new PiazzaClient(new Browser(), piazzaHost);
      try {
        await client.login(creds.piazza.email, creds.piazza.password);
      } catch (error) {
        if (error instanceof PiazzaAuthError) {
          markRejected("piazza", creds.piazza);
          throw needSignIn(PIAZZA_REJECTED, 6 * 3600_000);
        }
        throw new Error(`Couldn't reach Piazza right now (${(error as Error).message}). Try again in a moment.`);
      }
      piazzaClient = client;
    }
    return piazzaClient;
  }
  // A Piazza call that fails because the session ended: sign in again once.
  async function withPiazza<T>(run: (p: PiazzaClient) => Promise<T>): Promise<T> {
    try {
      return await run(await piazzaReady());
    } catch (error) {
      if (!(error instanceof PiazzaAuthError)) throw error;
      piazzaClient = undefined;
      return run(await piazzaReady());
    }
  }
  const piazza: PiazzaLike = {
    get configured() {
      return Boolean(loadCredentials().piazza);
    },
    classes: () => withPiazza((p) => p.classes()),
    findClass: (q) => withPiazza((p) => p.findClass(q)),
    search: (id, q) => withPiazza((p) => p.search(id, q)),
    post: (id, n) => withPiazza((p) => p.post(id, n)),
  };

  const fetchSyllabus = async (course: MoodleCourse) => {
    const attempt = () =>
      harvestSyllabi(cache, needBrowser(), ref.session!.props.moodleBase, [course], reichmanCreds() ?? { username: "", password: "" }, testOverride("SYLLABUS_URL") ?? DEFAULT_SYLLABUS_URL);
    let report = await attempt();
    if (report.failures.length > 0) {
      await connectReichman();
      report = await attempt();
    }
    if (report.failures.length > 0) throw new Error(report.failures.join("; "));
  };

  // Local sign-in page: verifies each login against the real service before saving it.
  setup = new SetupServer({
    verifyReichman: async (username, password) => {
      try {
        ref.session = await signIn({ username, password });
        return { ok: true, name: ref.session!.props.fullName };
      } catch (error) {
        const code = (error as LoginError).code;
        if (code !== "bad_credentials") log("sign-in check failed:", (error as Error).message);
        const message =
          code === "bad_credentials"
            ? "Wrong username or password. Use the same login as Moodle and My RUNI."
            : code === "mfa_required"
              ? "Reichman asked for a second verification step, which isn't supported yet."
              : "Couldn't reach Reichman's login right now. Check your internet connection and try again.";
        return { ok: false, error: message };
      }
    },
    verifyPiazza: async (email, password) => {
      try {
        piazzaClient = new PiazzaClient(new Browser(), piazzaHost);
        await piazzaClient.login(email, password);
        return { ok: true };
      } catch (error) {
        piazzaClient = undefined;
        if (error instanceof PiazzaAuthError) return { ok: false, error: "Wrong Piazza email or password." };
        log("Piazza check failed:", (error as Error).message);
        return { ok: false, error: "Couldn't reach Piazza right now. Try again in a moment." };
      }
    },
    onChange: () => {
      piazzaClient = undefined; // force re-login with new creds next time
      resetGatewayClients();
    },
  });
  await setup.start();

  const server = buildServer(null, cache, {
    onSessionExpired: connectReichman,
    ensureConnected: ensureReichman,
    fetchSyllabus,
    panopto,
    michlol,
    piazza,
    srtToText,
    saveFile: saveCourseFile,
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
      const url = await setup.ensureServing();
      openInBrowser(url);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `The sign-in page is opening in the user's browser. Also show them this link as a clickable link, in case the browser didn't come to the front: ${url}\n` +
              `There they can connect or change their Reichman login and add or update Piazza. Once they're done, tools work right away (no restart).\n` +
              `(Connector version ${runningVersion()}.)`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "connector_status",
    {
      title: "Connector status",
      description:
        "Shows the connector's version and whether Reichman, the Student Info Station, Panopto and Piazza are signed in, plus the last sign-in problem. For troubleshooting; doesn't open anything.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const saved = loadCredentials();
      const reichman = !saved.reichman ? "not connected" : saved.reichmanRejected ? "saved password rejected — needs signing in again" : "login saved";
      const piazzaState = !saved.piazza ? "not connected" : saved.piazzaRejected ? "saved password rejected" : piazzaClient ? "signed in" : "login saved";
      const lines = [
        `Connector version: ${runningVersion()}`,
        `Reichman: ${reichman}${ref.session ? `; Moodle signed in (${ref.session.props.moodleBase})` : ""}`,
        `Piazza: ${piazzaState}`,
        lastProblem ? `Last sign-in problem (${lastProblem.at}): ${lastProblem.message}` : "No sign-in problems since the connector started.",
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
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
      rotateSetupKey(); // old sign-in links stop working
      ref.session = null;
      piazzaClient = undefined;
      resetGatewayClients();
      return { content: [{ type: "text" as const, text: "Deleted your saved logins and cached course data. Use connect_account to sign in again." }] };
    },
  );

  // Answer Claude right away; sign in in the background (tools wait for it if they need it).
  await server.connect(new StdioServerTransport());
  const version = runningVersion();
  log(`ready (v${version})`);
  const saved = loadCredentials();
  if (!saved.reichman) {
    if (openOnce(setup.url())) log("no account saved; opened the sign-in page");
  } else if (saved.reichmanRejected) {
    if (openOnce(setup.url(), 6 * 3600_000)) log("saved Reichman password was rejected earlier; opened the sign-in page");
  }
  // No sign-in at startup: Claude Desktop may start several copies at once, and they'd all sign
  // in together. Tools sign in on first use, one process at a time (withSignInLock).
}

// `install` / `uninstall` (one-step setup for the ChatGPT app) run and exit; otherwise serve MCP.
// Two roles, one program:
//  - the launcher (what Claude starts): passes messages through to a child process running the
//    real connector, and swaps in new versions while running (supervisor.ts);
//  - the connector itself (RUNI_CHILD=1): serves the tools.
async function start() {
  if (runCli(process.argv, __filename)) return;
  if (process.env.RUNI_CHILD) return main();
  const interval = Number(testOverride("RUNI_UPDATE_INTERVAL_MS")) || 30 * 60_000;
  supervise({
    selfPath: __filename,
    selfVersion: runningVersion(),
    dataDir: dataDir(),
    log,
    checkEveryMs: interval,
    updates: selfUpdate,
  });
}

start().catch((error) => {
  log("fatal:", (error as Error).message);
  process.exit(1);
});
