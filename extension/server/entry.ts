/**
 * Entry point for the Claude Desktop extension (.mcpb).
 *
 * Claude Desktop passes the student's Reichman username and password as environment
 * variables (from the extension's settings UI, where the password is marked sensitive
 * and stored by the OS, not by us). This process:
 *   1. signs in to Moodle once, keeping only the token in memory,
 *   2. serves the MCP tools over stdio,
 *   3. signs in again automatically if Moodle says the token expired.
 *
 * The password stays in this process's memory. It is never written to disk or logged.
 * Syllabus text (course info, not personal) is cached under the OS app-data dir.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { MoodleClient } from "../../src/moodle";
import { harvestSyllabi } from "../../src/syllabi";
import { signInToMoodle, type Credentials } from "../../src/reichman-login";
import { buildServer, type UserProps } from "../../src/tools";

const MOODLE_BASE = process.env.MOODLE_BASE?.trim() || "https://moodle.runi.ac.il/2027";

function log(...parts: unknown[]) {
  // stderr only — stdout is the MCP channel.
  console.error("[reichman]", ...parts);
}

function cacheDir(): string {
  const base =
    platform() === "win32"
      ? process.env.APPDATA || join(homedir(), "AppData", "Roaming")
      : platform() === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const dir = join(base, "runi-connector");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// File-backed cache for syllabus text, matching the KVNamespace shape the code expects.
function fileCache(): KVNamespace {
  const path = join(cacheDir(), "syllabi.json");
  const data: Record<string, string> = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  return {
    async get(key: string, type?: "text" | "json") {
      const value = data[key];
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      data[key] = value;
      writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
    },
  } as unknown as KVNamespace;
}

async function signIn(credentials: Credentials): Promise<{ props: UserProps; harvest: () => Promise<void> }> {
  const { moodleToken, browser } = await signInToMoodle(MOODLE_BASE, credentials);
  const moodle = new MoodleClient(MOODLE_BASE, moodleToken);
  const site = await moodle.siteInfo();
  const props: UserProps = {
    moodleToken,
    moodleBase: MOODLE_BASE,
    userId: site.userid,
    fullName: site.fullname,
  };
  const harvest = async () => {
    try {
      const courses = await moodle.courses(site.userid);
      const report = await harvestSyllabi(fileCache(), browser, MOODLE_BASE, courses, credentials);
      log("syllabi:", JSON.stringify(report));
    } catch (error) {
      log("syllabus harvest failed:", (error as Error).message);
    }
  };
  return { props, harvest };
}

async function main() {
  const username = (process.env.RUNI_USERNAME || "").trim();
  const password = process.env.RUNI_PASSWORD || "";
  if (!username || !password) {
    log("Missing username or password. Open the extension's settings in Claude Desktop and fill them in.");
    process.exit(1);
  }
  const credentials: Credentials = { username, password };

  let first: Awaited<ReturnType<typeof signIn>>;
  try {
    first = await signIn(credentials);
  } catch (error) {
    log("Sign-in failed:", (error as Error).message);
    process.exit(1);
    return;
  }
  log(`signed in as ${first.props.fullName}`);
  void first.harvest(); // collect syllabi in the background

  const server = buildServer(first.props, fileCache(), {
    onSessionExpired: async () => {
      log("token expired; signing in again");
      const again = await signIn(credentials);
      void again.harvest();
      return again.props;
    },
  });
  await server.connect(new StdioServerTransport());
  log("ready");
}

main().catch((error) => {
  log("fatal:", (error as Error).message);
  process.exit(1);
});
