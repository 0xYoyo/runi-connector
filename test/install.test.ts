// One-step ChatGPT/Codex setup: `reichman-courses-connector install`.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withoutOurServer } from "../extension/server/install";

const BUNDLE = join(process.cwd(), "dist", "extension", "server", "index.js");

describe("install for ChatGPT / Codex", () => {
  it("removes only our server table from config.toml", () => {
    const toml = `model = "x"\n\n[mcp_servers.other]\ncommand = "a"\n\n[mcp_servers.reichman]\ncommand = "old"\n\n[mcp_servers.reichman.env]\nA = "1"\n\n[profiles.p]\nk = 1\n`;
    const out = withoutOurServer(toml);
    expect(out).toContain("[mcp_servers.other]");
    expect(out).toContain("[profiles.p]");
    expect(out).not.toContain("reichman");
  });

  it.skipIf(!existsSync(BUNDLE))("writes an absolute-path entry, keeps other settings, and is idempotent", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-"));
    const dataDir = mkdtempSync(join(tmpdir(), "runi-data-"));
    writeFileSync(join(codexHome, "config.toml"), `model = "gpt"\n\n[mcp_servers.other]\ncommand = "x"\n`);
    // A stand-in `claude` CLI that records how it was called.
    const fakeClaude = join(codexHome, "fake-claude.sh");
    writeFileSync(fakeClaude, `#!/bin/sh\necho "$@" >> "${join(codexHome, "claude-calls.txt")}"\n`, { mode: 0o755 });
    const env = { ...process.env, CODEX_HOME: codexHome, RUNI_DATA_DIR: dataDir, RUNI_NO_SELF_UPDATE: "1", RUNI_CLAUDE_BIN: fakeClaude };
    const out = execFileSync(process.execPath, [BUNDLE, "install"], { env, encoding: "utf8" });
    expect(out).toContain("added to ChatGPT");
    expect(out).toContain("Claude Code");
    execFileSync(process.execPath, [BUNDLE, "install"], { env, encoding: "utf8" }); // twice
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config.match(/\[mcp_servers\.reichman\]/g)).toHaveLength(1);
    expect(config).toContain(`command = ${JSON.stringify(process.execPath)}`);
    expect(config).toContain(JSON.stringify(join(dataDir, "app", "runi-connector.js")));
    expect(config).toContain("[mcp_servers.other]");
    expect(config).toContain('model = "gpt"');
    expect(existsSync(join(dataDir, "app", "runi-connector.js"))).toBe(true);
    const calls = readFileSync(join(codexHome, "claude-calls.txt"), "utf8");
    expect(calls).toContain(`mcp add --transport stdio --scope user reichman -- ${process.execPath} ${join(dataDir, "app", "runi-connector.js")}`);
    execFileSync(process.execPath, [BUNDLE, "uninstall"], { env, encoding: "utf8" });
    expect(readFileSync(join(codexHome, "claude-calls.txt"), "utf8").trim().split("\n").pop()).toBe("mcp remove reichman --scope user");
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).not.toContain("reichman");
  });
});
