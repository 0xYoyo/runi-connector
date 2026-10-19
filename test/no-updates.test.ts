// No automatic updates (owner's decision, 2026-10-19): the connector never downloads or runs code
// it wasn't installed with. It also removes what older self-updating versions downloaded.
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeOldDownloads } from "../extension/server/updates";

const BUNDLE = join(process.cwd(), "dist", "extension", "server", "index.js");

describe("no automatic updates", () => {
  it.skipIf(!existsSync(BUNDLE))("the built connector never contacts the npm registry or carries the old auto-updater", () => {
    const code = readFileSync(BUNDLE, "utf8");
    expect(code).not.toContain("registry.npmjs.org");
    // The old auto-updater's markers (its handshake id and download file names).
    expect(code).not.toContain("__runi_internal_initialize__");
    expect(code).not.toMatch(/server-\$\{/);
  });

  it("removes old self-update downloads but keeps the install copy", () => {
    const dir = mkdtempSync(join(tmpdir(), "old-"));
    mkdirSync(join(dir, "app"));
    for (const f of ["server-1.6.3.js", "server-1.6.3.ok", "server-1.6.4.bad", "runi-connector.js"]) writeFileSync(join(dir, "app", f), "x");
    writeFileSync(join(dir, "launcher-status.json"), "{}");
    removeOldDownloads(dir);
    expect(existsSync(join(dir, "app", "server-1.6.3.js"))).toBe(false);
    expect(existsSync(join(dir, "app", "server-1.6.4.bad"))).toBe(false);
    expect(existsSync(join(dir, "launcher-status.json"))).toBe(false);
    expect(existsSync(join(dir, "app", "runi-connector.js"))).toBe(true);
  });
});
