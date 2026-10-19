// Launchers before 1.6.3 marked good versions as bad (their child processes couldn't start inside
// Claude Desktop). Only marks made by the worker-thread launcher may rule a version out.
import { expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markBad, pickDownloadedVersion } from "../extension/server/updates";

it("ignores old-style bad marks, honours new ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "marks-"));
  mkdirSync(join(dir, "app"));
  writeFileSync(join(dir, "app", "server-9.0.0.js"), "//");
  writeFileSync(join(dir, "app", "server-9.0.0.bad"), String(Date.now())); // written by an old launcher
  expect(pickDownloadedVersion(dir, "1.0.0")?.version).toBe("9.0.0");
  markBad(dir, "9.0.0");
  expect(pickDownloadedVersion(dir, "1.0.0")).toBeNull();
});
