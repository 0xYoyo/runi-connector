# Reichman Courses (unofficial)

Ask Claude about your own Reichman University courses, in plain language:

> "What's the grade formula for Algorithms?"
> "What's due this week?"
> "Find Max's recitation 5 in probability and tell me if he covers the bell curve."
> "What did I get in Digital Systems?"

It runs on your own computer, signs in with your Reichman account, and is **read-only**.

**Unofficial student project. Not affiliated with or endorsed by Reichman University.**

## Install — Claude Desktop (no terminal)

1. Install the free **Claude Desktop** app (Mac or Windows).
2. Download **`reichman-courses.mcpb`** from the [latest release](https://github.com/0xYoyo/runi-connector/releases/latest) and double-click it. Click Install.
3. A sign-in page opens in your browser. Enter your Reichman username and password (it's checked on the spot). Add Piazza on the next step if you use it, or skip.
4. In any chat: *"list my courses"*, *"what's due this week?"*

To sign in again, change your login, or add Piazza later, ask Claude to **"connect my Reichman account"** (the `connect_account` tool reopens the sign-in page).

## Install — ChatGPT app (Codex) or Claude Code

Needs [Node.js](https://nodejs.org) 18+. One line, no clone:

**ChatGPT app:** Settings → MCP servers → Add, choose **STDIO**, command `npx`, args `-y reichman-courses-connector`. Or add to `~/.codex/config.toml`:

```toml
[mcp_servers.reichman]
command = "npx"
args = ["-y", "reichman-courses-connector"]
```

**Claude Code:**

```sh
claude mcp add --scope user reichman -- npx -y reichman-courses-connector
```

The first run opens the same sign-in page in your browser. `npx` always fetches the latest version, so these stay up to date on their own.

## What it can do

Moodle: list courses, read the syllabus (grade formula, AI policy, attendance, reading list), browse course contents, read a PDF or slide, upcoming deadlines, assignments, Moodle grades, announcements, search materials.
Lectures: search Panopto recordings and read their transcripts (with timestamps).
Student Info Station: official grades, exam schedule, weekly timetable.
Piazza (optional, separate login): list classes, search, read posts.
Plus `connect_account` (open the sign-in page) and `forget_my_data` (delete your saved login and cached data).

Courses can be named in Hebrew or English, by course number (`77`), or by Moodle id.

## How sign-in works, and what happens to your password

Reichman doesn't offer outside apps a "Sign in with Reichman" button, and students can't generate a Moodle API token themselves. So the connector completes the normal university login for you, on your own computer.

- Your password is **verified against Reichman's real login** before anything is saved, then kept in your computer's own secure storage — macOS Keychain, Windows' encrypted user storage, or a private file on other systems.
- It is used only to sign in to Reichman (and Piazza, if you add it). It is never logged, never sent anywhere else, and a test asserts it never appears in any error or trace.
- The sign-in page runs locally, loads nothing external, and is protected by a one-time key so no other program or website can drive it.
- Everything is read-only. `forget_my_data` erases it all.

> Your Reichman password also opens email and other university systems. This tool never keeps it anywhere but your own machine, but it is unofficial — use it on your own account only, if you're comfortable with that.

## Releasing a new version

Push a tag and GitHub Actions builds and publishes everything:

```sh
npm version patch   # or minor / major — bumps package.json + git tag
git push --follow-tags
```

The workflow runs the tests, builds `reichman-courses.mcpb`, attaches it to a GitHub Release, and (if an `NPM_TOKEN` secret is set) publishes the npm package. Running connectors notice the new release and tell the user to update; `npx` users update automatically. Bump `extension/manifest.json`'s `version` to match before tagging.

## Deploy your own (Cloudflare Workers)

> Currently blocked: Reichman's Moodle challenges requests from Cloudflare's servers (Reblaze bot protection). Kept for when official access is granted.

```sh
npm install
npx wrangler kv namespace create OAUTH_KV   # paste the id into wrangler.jsonc
npx wrangler kv namespace create CACHE_KV    # paste the id into wrangler.jsonc
# edit wrangler.jsonc: set PUBLIC_URL to your workers.dev URL, and MOODLE_BASE for the year
npm run deploy
# then set PUBLIC_URL again to the URL the deploy printed, and redeploy
```

`MOODLE_BASE` changes each academic year (`.../2027`, `.../2028`). Update it each October.

Then add `<your PUBLIC_URL>/mcp` as a custom connector in Claude (Settings → Connectors → Add custom connector), or the equivalent in ChatGPT, Codex or Gemini.

## Check the login before deploying

Run once on your own machine to confirm the flow works, whether there's a 2FA step, and how long a token lasts:

```sh
npm run probe                              # prompts for your login, prints the token + step trace
npm run probe -- --verify <token>          # later: is that token still valid?
```

The probe reads your password from a hidden prompt and never writes it anywhere.

## Develop and test

```sh
npm test            # 8 tests against a fake Reichman; no real login or network
npm run typecheck   # worker + test typechecks

# optional full end-to-end against the OAuth flow:
npx tsx test/run-mock.ts                        # terminal 1: fake Reichman
npx wrangler dev --config wrangler.e2e.jsonc    # terminal 2: the worker
npx tsx test/e2e.ts                             # terminal 3: the client
```

## Layout

```
src/
  browser.ts          minimal cookie-jar HTTP client + HTML form parser (login flow)
  reichman-login.ts   walks Moodle → university login → Moodle app token
  moodle.ts           Moodle web-service REST client (token based)
  syllabi.ts          collects syllabus PDFs during sign-in, caches text in KV
  documents.ts        PDF and text extraction
  tools.ts            the MCP tools
  pages.ts            sign-in / message pages (no external resources)
  index.ts            OAuth provider + MCP endpoint wiring
```

## Roadmap

- Measure Moodle token lifetime; add silent refresh if the token allows it.
- Add a 2FA prompt to the sign-in page if Reichman enables 2FA.
- Once it has real users, propose official registration to Reichman IT for a password-free sign-in and a wider set of data (grades, exams and schedule from My RUNI).

## License

MIT. Use at your own risk; this is not an official Reichman University product.
