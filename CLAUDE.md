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

## Extra services (local versions only; src/*.ts + wired in extension/server/entry.ts)

- `src/panopto.ts` PanoptoClient: reuses the Moodle Browser (auto-auth via `?instance=MoodleProd{year}`). GetSessions JSON API + GenerateSRT.ashx transcripts. Tools: search_lectures, get_lecture_transcript. `srtToText` compacts captions to `[m:ss] text`.
- `src/michlol.ts` MichlolClient: Student Info Station (yedion.runi.ac.il), same SSO via the Moodle Browser. fireflyweb.aspx POSTs: MenuCall to open a page, StudentQueryExecution to run a query. Tool: get_official_grades. MENU map holds the menu-item ids.
- `src/piazza.ts` PiazzaClient: SEPARATE login (saved via the sign-in page's optional step 2). Form login + JSON-RPC (see below). Tools: piazza_list_classes/search/read_post.
- Hosts are overridable by env (PANOPTO_HOST, MICHLOL_HOST, PIAZZA_HOST, SYLLABUS_URL, RUNI_REGISTRY) for tests only; defaults are the real hosts.
- Panopto/Michlol/Piazza tools are registered only when buildServer gets their BuildOptions providers, so the hosted Worker never exposes them.

## Sign-in, credential store, updates (v1.0, extension/server/)

- `credentials.ts`: OS secure store — macOS Keychain (`security -i`, value via stdin), Windows DPAPI (PowerShell), else 0600 file. Hex-encoded JSON. Env overrides for tests: RUNI_DATA_DIR, RUNI_CREDENTIALS_BACKEND=file.
- `setup-page.ts` + `setup-server.ts`: the connector's own two-step sign-in page on 127.0.0.1, nonce-protected (page needs ?k=nonce; POSTs need X-Setup-Nonce). Verifies each login against the real service before saving. CSP loads nothing external. Opened on first run and via the `connect_account` tool.
- `entry.ts`: starts the MCP server immediately (no sign-in at startup); opens the sign-in page once if no login is saved. Tools connect on demand (buildServer gets null props + `ensureConnected`). `connect_account` returns the page link for Claude to show. `forget_my_data` clears store + cache.
- Updates WITHOUT RESTART (v1.5, extension/server/supervisor.ts): what the app starts is a launcher that runs the real connector as a child (`RUNI_CHILD=1`) and passes MCP's newline-delimited JSON-RPC through. Every 30 min (and on a tool call, at most every 2 min) it downloads a newer npm version (`updates.ts`: registry `latest`, tarball sha512 checked against the registry's `integrity`, saved to `<dataDir>/app/server-<v>.js`), starts it as a new child, replays the client's `initialize` + `initialized` (internal id `__runi_internal_initialize__`), waits until no request is in flight, switches, and sends `notifications/tools/list_changed`. A version that fails its handshake or crashes 3× in a minute is `markBad`; crashed children are restarted and pending requests get a retry error. Only `.bad` rules a version out (started-but-not-ok used to wrongly skip versions when Claude Desktop closed extra copies). Older installed launchers `require` the newest download with RUNI_LAUNCHED set; the new code then becomes the launcher and immediately marks itself healthy. Tests: test/hot-update.test.ts. `connector_status` tool reports version, sign-in state and last problem. `RUNI_NO_SELF_UPDATE=1` disables updates; `RUNI_UPDATE_INTERVAL_MS` (test mode) speeds checks. Version is baked in via esbuild define `__APP_VERSION__`; build fails if manifest.json and package.json versions differ.
- `setup-server.ts`: fixed port 51547 (RUNI_SETUP_PORT, tests use 0) + key shared via `<dataDir>/setup-key`, so the several processes Claude Desktop starts serve one page; `openOnce` debounces auto-open (5 min). Stable origin also lets password managers save the login.
- The password is never sent twice in one sign-in (a password form shown again stops the sign-in; it's only a wrong password with Reichman's error text). Michlol (yedion) and Panopto each go through the My RUNI F5 gateway again: both use `navigateThroughLogin` with the saved creds, and the password is only typed into *.runi.ac.il pages (`isReichmanHost`). Piazza: form login at /account/login → POST /class (csrf_token), API at /logic/api?method=X with CSRF-Token header from /main/csrf_token.
- npm bin `reichman-courses-connector` → `dist/extension/server/index.js` (shebang added by build). ChatGPT/Codex install: `npx -y reichman-courses-connector@latest install` (extension/server/install.ts) copies the bundle to `<dataDir>/app/runi-connector.js` and writes `[mcp_servers.reichman]` to `~/.codex/config.toml` (CODEX_HOME) with absolute node + script paths (GUI apps often lack nvm's PATH); It also runs `claude mcp add --transport stdio --scope user reichman -- <node> <script>` if the `claude` CLI exists (RUNI_CLAUDE_BIN for tests). `uninstall` removes both. Users paste one line into a Codex / Claude Code chat. Claude Code: `claude mcp add ... -- npx -y reichman-courses-connector@latest`. Package name: reichman-courses-connector.
- Release: `.github/workflows/release.yml` runs on every push to main; if package.json's version isn't on npm yet it tests, builds, creates GitHub Release v<version> with the .mcpb, and `npm publish`es via npm trusted publishing (OIDC, no token; configured on npmjs.com for workflow release.yml). Bump package.json + manifest.json versions together.
- Lifecycle (tests in test/lifecycle.test.ts): startup answers MCP immediately and does NOT sign in; the first tool that needs Reichman signs in (single-flight `connectReichman`, and across processes `withSignInLock` on `<dataDir>/signin.lock`, because Claude Desktop runs several copies and overlapping sign-ins make the F5 gateway reload its login page). A reappearing login form counts as a wrong password only if it carries Reichman's error text (`WRONG_DETAILS`). A bad_credentials result sets `reichmanRejected`/`piazzaRejected` in the credential store: the saved password is never retried until the user saves a new one on the page (lockout protection); tools then return a NotConnectedError whose message carries the sign-in link. Panopto/Michlol LoginErrors go through the same handler. `RUNI_NO_BROWSER=1` stops tests opening a browser.
- Live facts (checked in the user's Chrome 2026-10-16): Panopto sign-in starts at `Login.aspx?instance=IDCPROD&AllowBounce=true` (provider "RUNI Account"; MoodleProd{year} only works when launched from Moodle; without AllowBounce a signed-out client gets a 200 ASP.NET page whose script bounces on) → my.runi F5 SAML → back. ASP.NET hidden page-state forms are never treated as auto-post steps. My RUNI's F5 gateway ties a session to the service it was opened for ("access not found" at F5Networks-SSO-Req when reused, seen live 2026-10-19), and "RUNI Account" (IDCPROD) signs a student in but is then refused with "BIG-IP ACL denied" (route seen live 2026-10-19; likely staff-only). So Panopto signs in through Moodle's session with provider MoodleProd{year} (Panopto → moodle blocks/panopto SSO → back), with IDCPROD via the Student Info Station's gateway session only as a fallback (`PanoptoRoute[]` in src/panopto.ts, wired in entry.ts `clientsFor`). Michlol keeps its own gateway Browser and clears the jar + retries once on an unexpected_page. Sign-in failure messages end with `[connector vX]`. `connect_account` output includes the running version. Michlol query screens: grades menu 13 and timetable 16 submit `PRGNAME=StudentQueryExecution, ARGUMENTS=TZ,Token,QueryCode,R1C1,R1C2`; exams menu 6 submits `PRGNAME=HADPASAT_TOCHNIT_BEHINOT, ARGUMENTS=TZ,Token,R1C1,R1C2,R1C3` (R1C3 = Terms). Use the page's selected year/semester as defaults. Results are `.MasterTable .Table > .row > .col` grids; grade cards `.Box_ph` with `.InRange` [course, credits/מועד, component]. Strip the ID number (מ.ז) from anything returned.
- Security (audit 2026-10-16, tests in test/security.test.ts): the password is typed only into *.runi.ac.il pages over HTTPS via POST (`safeToTypePassword`); Browser refuses to resend a form body on a 307/308 to another origin or non-HTTPS; Referer never carries a query string; the Piazza password only goes to piazza.com. All env overrides (hosts, registry, MOODLE_BASE, loopback logins) work only with `RUNI_TEST_MODE=1` (src/test-mode.ts; vitest sets it). Setup server: requests must have `Host: 127.0.0.1:<port>` (anti DNS rebinding); `/__runi` is HMAC challenge-response with the private setup-key, so a port squatter is never trusted; key rotates on forget_my_data. Wrong password is recognised only by Reichman's real message (`WRONG_DETAILS`, live page auth.runi.ac.il/vdesk/hangup.php3), never by a generic dead end. Workflow actions are pinned to SHAs. Residual: anyone who can publish the npm package (maintainer 2FA, or this repo's release workflow) can ship code to all installs; the keychain item is readable by processes running as the same user.
- Anthropic's directory won't take this: policy 3.F requires owning/controlling every endpoint the software connects to (Reichman's sites). Self-update via npm is the update path.
- `download_course_files` (local only, `BuildOptions.saveFile` → entry.ts `saveCourseFile`): saves original Moodle files under the user's home folder only (relative paths are relative to home; `~` expanded; realpath checked so symlinks can't escape); default `~/Downloads/Reichman/<course>`; same-size files skipped; max 80 per call. Writes to the user's disk, never to Moodle. Server instructions tell the model to use the connector instead of browsing Reichman sites.
- Michlol: grades/weeklySchedule/examSchedule via `runQuery` (see live facts above). contactAdminForm exists but NO send tool yet — a real write to student admin needs careful live verification before enabling; gate it behind confirm-before-send when added.

## Notes

- `MOODLE_BASE` is per academic year (`https://moodle.runi.ac.il/2027`); update every October.
- Real login verified 2026-10-14: Moodle launch.php → auth.runi.ac.il SAML IdP → my.runi.ac.il F5 my.policy login → back; no 2FA. Token lifetime not yet measured.
- Commit as `0xYoyo <113042560+0xYoyo@users.noreply.github.com>`; GitHub rejects pushes that expose the private email.
