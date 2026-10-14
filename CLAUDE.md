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

## Notes

- `MOODLE_BASE` is per academic year (`https://moodle.runi.ac.il/2027`); update every October.
- Real-login behavior (2FA, token lifetime, exact IdP pages) is not yet verified; `npm run probe` output is the source of truth.
- Commit as `0xYoyo <113042560+0xYoyo@users.noreply.github.com>`; GitHub rejects pushes that expose the private email.
