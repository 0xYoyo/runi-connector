# RUNI Connector

Unofficial remote MCP server (Cloudflare Worker) that lets Reichman University students query their own Moodle courses and syllabi from Claude, ChatGPT, Codex or Gemini. Owner: Yoyo (0xYoyo). See README.md for the user-facing description.

## Commands

- `npm install` — install deps (run on the machine you'll use; wrangler ships native binaries)
- `npm test` — vitest suite against a fake Reichman (test/mock-reichman.ts); no network, no real login
- `npm run typecheck` — worker types (tsconfig.json) and test/script types (tsconfig.test.json)
- `npm run dev` — local worker via wrangler
- `npm run deploy` — deploy to Cloudflare (needs `npx wrangler login` and KV ids in wrangler.jsonc)
- `npm run probe` — interactive check of the REAL Reichman login (prompts for the user's own credentials). Never run it non-interactively or with credentials passed as arguments.
- Optional e2e: `npx tsx test/run-mock.ts` + `npx wrangler dev --config wrangler.e2e.jsonc` + `npx tsx test/e2e.ts`

## Architecture

- `src/index.ts` — OAuthProvider (@cloudflare/workers-oauth-provider): `/authorize` sign-in page, `/oauth/token`, `/register`, and the stateless MCP endpoint at `/mcp`.
- `src/reichman-login.ts` + `src/browser.ts` — walks Moodle `admin/tool/mobile/launch.php` → SAML → university login form → back to Moodle, and reads the Moodle app token from the final `moodlemobile://token=` redirect.
- `src/moodle.ts` — Moodle REST client using that token (`webservice/rest/server.php`).
- `src/syllabi.ts` — during sign-in only, finds `SectionIDC` links on course pages and caches syllabus PDF text in `CACHE_KV` (shared; syllabi are course info, not personal data).
- `src/tools.ts` — the MCP tools. `src/pages.ts` — HTML pages.

## Non-negotiable rules

- The user's password must only ever exist in memory during the sign-in request. Never log it, store it in KV, put it in props/metadata, error messages, traces, analytics, or URLs. `test/flow.test.ts` asserts this; keep that test passing and extend it if you touch the login path.
- Only the Moodle token is persisted, inside OAuth `props` (encrypted by the provider). Grant `metadata` is unencrypted: keep it empty.
- The sign-in page must stay script-free and load no external resources (see `SIGN_IN_PAGE_HEADERS` in src/index.ts).
- Tools are read-only. Don't add tools that submit, post, or change anything in Moodle without Yoyo explicitly asking.
- The product is unofficial: never use Reichman logos/branding or imply affiliation.

## Local version (the one that works today)

- `local/login.ts` (`npm run login`) signs in once and saves only the Moodle token to `~/.runi-connector/session.json` (mode 600); syllabi cache in `~/.runi-connector/cache.json`.
- `local/server.ts` (`npm run mcp`) is a stdio MCP server reusing `src/tools.ts`. Never write to stdout there; it's the MCP channel.
- Hosted Worker is blocked: Reichman's Moodle sits behind Reblaze bot protection, which returns an HTTP 247 JS challenge to Cloudflare egress. Do not try to evade it (no headless-browser challenge solving, proxies or UA spoofing). Hosted access waits on official permission from Reichman IT.

## Desktop extension (.mcpb) — easiest install for non-technical users

- `extension/manifest.json` + `extension/server/entry.ts`: a Claude Desktop extension. `user_config` collects username + password (password `sensitive: true`, stored by the OS keychain, passed as env vars). The server signs in itself and auto-refreshes on token expiry (`buildServer`'s `onSessionExpired`).
- `scripts/build-extension.mjs` (`npm run build:ext`) bundles `entry.ts` + deps with esbuild into `dist/extension/server/index.js` and zips `dist/reichman-courses.mcpb`. `npm run test:ext` builds then runs `test/mcpb-bundle.test.ts`.
- Same non-negotiable rules apply: password only in memory, token only in the OS-provided secure config + the local syllabus cache. Don't log the password.
- This is the local/stdio transport, so it is NOT subject to the Reblaze block — it runs on the user's machine.

## Notes

- `MOODLE_BASE` is per academic year (`https://moodle.runi.ac.il/2027`); update every October.
- Real login verified 2026-10-14: Moodle launch.php → auth.runi.ac.il SAML IdP → my.runi.ac.il F5 my.policy login → back; no 2FA. Token lifetime not yet measured.
- Commit as `0xYoyo <113042560+0xYoyo@users.noreply.github.com>`; GitHub rejects pushes that expose the private email.
