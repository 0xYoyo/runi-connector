// Builds the Claude Desktop extension (.mcpb): bundles the stdio server into one JS file
// with all dependencies, then zips it together with the manifest and icon.
//
//   node scripts/build-extension.mjs
//
// Output: dist/reichman-courses.mcpb

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const staging = join(root, "dist", "extension");
const outFile = join(root, "dist", "reichman-courses.mcpb");

rmSync(join(root, "dist"), { recursive: true, force: true });
mkdirSync(join(staging, "server"), { recursive: true });

// 1. Bundle the TypeScript server + all deps (unpdf, the MCP SDK, etc.) into one CJS file.
// The shebang + banner lets the same file run as `node index.js` (inside the .mcpb) and as a
// CLI via `npx` (for Codex / Claude Code), where a working directory may not be writable.
await build({
  entryPoints: [join(root, "extension", "server", "entry.ts")],
  outfile: join(staging, "server", "index.js"),
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  minify: true,
  legalComments: "none",
  banner: { js: "#!/usr/bin/env node" },
});
chmodSync(join(staging, "server", "index.js"), 0o755);

// 2. Copy the manifest and icon next to it.
cpSync(join(root, "extension", "manifest.json"), join(staging, "manifest.json"));
const icon = join(root, "extension", "icon.png");
if (existsSync(icon)) cpSync(icon, join(staging, "icon.png"));

// 3. Zip the staging folder into a .mcpb (a .mcpb is just a zip).
execFileSync("zip", ["-r", "-q", outFile, "manifest.json", "server", ...(existsSync(icon) ? ["icon.png"] : [])], {
  cwd: staging,
});

console.log(`Built ${outFile}`);
