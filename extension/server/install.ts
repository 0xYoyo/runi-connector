// `npx reichman-courses-connector install` — adds the connector to the ChatGPT desktop app
// (Codex) and, if installed, Claude Code, in one step, so a user can paste one line into a chat.
//
// It copies this very program into the connector's own data folder and registers it in
// ~/.codex/config.toml (shared by the ChatGPT desktop app, the Codex CLI and IDE extensions)
// using absolute paths to Node and to that copy. Absolute paths matter: apps opened from the
// Dock often can't find a Node installed with nvm/Homebrew. Updates still arrive on their own
// (updates.ts), and the saved login is the same one Claude Desktop uses.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDir } from "./credentials";

export const SERVER_NAME = "reichman";

const codexConfigPath = () => join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
const tomlString = (value: string) => JSON.stringify(value); // JSON escapes are valid TOML basic-string escapes

/** Removes our `[mcp_servers.reichman]` table (and its sub-tables) from a config.toml text. */
export function withoutOurServer(toml: string): string {
  const lines = toml.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/);
    if (header) skipping = header[1] === `mcp_servers.${SERVER_NAME}` || header[1].startsWith(`mcp_servers.${SERVER_NAME}.`);
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

// Registers the connector with Claude Code (user scope = every project), if Claude Code is
// installed. Uses its own CLI rather than editing its config file.
function registerClaudeCode(command: string, args: string[]): boolean {
  const claude = process.env.RUNI_CLAUDE_BIN || "claude";
  const probe = spawnSync(claude, ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
  if (probe.status !== 0) return false;
  spawnSync(claude, ["mcp", "remove", SERVER_NAME, "--scope", "user"], { stdio: "ignore", shell: process.platform === "win32" });
  const added = spawnSync(claude, ["mcp", "add", "--transport", "stdio", "--scope", "user", SERVER_NAME, "--", command, ...args], {
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  return added.status === 0;
}

export function install(selfPath: string): { codexConfig: string; claudeCode: boolean } {
  // 1. A stable copy of the program (npx's own copy lives in a cache that can be cleared).
  const appDir = join(dataDir(), "app");
  mkdirSync(appDir, { recursive: true, mode: 0o700 });
  const stable = join(appDir, "runi-connector.js");
  copyFileSync(selfPath, stable);

  // 2. Register it with ChatGPT / Codex.
  const configPath = codexConfigPath();
  mkdirSync(join(configPath, ".."), { recursive: true });
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const block = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(process.execPath)}`,
    `args = [${tomlString(stable)}]`,
    `startup_timeout_sec = 30`,
  ].join("\n");
  const base = withoutOurServer(existing);
  writeFileSync(configPath, (base ? `${base}\n\n` : "") + block + "\n");

  // 3. And with Claude Code, if it's installed.
  const claudeCode = registerClaudeCode(process.execPath, [stable]);
  return { codexConfig: configPath, claudeCode };
}

export function uninstall(): string {
  const configPath = codexConfigPath();
  if (existsSync(configPath)) writeFileSync(configPath, withoutOurServer(readFileSync(configPath, "utf8")) + "\n");
  const claude = process.env.RUNI_CLAUDE_BIN || "claude";
  spawnSync(claude, ["mcp", "remove", SERVER_NAME, "--scope", "user"], { stdio: "ignore", shell: process.platform === "win32" });
  return configPath;
}

/** Handles `install` / `uninstall`; returns true if it did (and the process should exit). */
export function runCli(argv: string[], selfPath: string): boolean {
  const command = argv[2];
  if (command === "install") {
    const { codexConfig, claudeCode } = install(selfPath);
    process.stdout.write(
      `Reichman Courses was added to ChatGPT (Codex) in ${codexConfig}` +
        (claudeCode ? ` and to Claude Code (all projects).\n` : `.\n`) +
        `Next: quit and reopen the ChatGPT app${claudeCode ? ", and start a new Claude Code session" : ""}. ` +
        `The first time you ask about your courses, a sign-in page opens in your browser (skipped if you already signed in on this computer).\n`,
    );
    return true;
  }
  if (command === "uninstall") {
    const where = uninstall();
    process.stdout.write(`Removed Reichman Courses from ${where}. Ask Claude/ChatGPT to "forget my Reichman data" first if you also want your saved login deleted.\n`);
    return true;
  }
  return false;
}
