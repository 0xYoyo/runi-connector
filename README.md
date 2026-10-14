# RUNI Connector (unofficial)

Ask Claude, ChatGPT, Codex or Gemini about your own Reichman University courses:

> "What's the grade formula for Algorithms?"
> "What's due this week?"
> "Summarize the week 3 slides in Digital Systems."
> "Is AI allowed on the Advanced Programming homework?"

It's a remote MCP server: you add it like the GitHub or Linear connector, sign in once with your Reichman account, and forget about it.

**Unofficial student project. Not affiliated with or endorsed by Reichman University. Opt-in and read-only.**

## Tools

| Tool | What it does |
| --- | --- |
| `list_courses` | Your current Moodle courses, with course numbers |
| `get_syllabus` | The official syllabus: topics, grade formula, AI policy, attendance, reading list |
| `get_course_contents` | Sections, activities and files in a course |
| `read_course_file` | Reads a PDF or text/code file from a course |
| `get_upcoming_deadlines` | Upcoming due dates across all courses |
| `get_assignments` | A course's assignments with due dates and instructions |
| `get_my_grades` | Your grade items in a course's Moodle gradebook |
| `get_announcements` | Latest posts in a course's announcements forum |
| `search_course_materials` | Finds activities and files by name across all courses |

Courses can be named in Hebrew or English, by course number (`77`) or by Moodle id.

## How sign-in works

Reichman doesn't offer outside apps a "Sign in with Reichman" button, and students can't generate a Moodle API token themselves. So the connector completes the normal university login for you once, and keeps only the Moodle app token it gets at the end (the same token the official Moodle mobile app uses).

What the server does with your credentials:

- Your password is used for a single login request and is **never** written to the database, logs, or analytics. A unit test asserts it never appears in any error message or request trace.
- Only the resulting **Moodle token** is stored, encrypted by the OAuth layer so that only your connected AI app can unwrap it. The server operator cannot read it from the database.
- The sign-in page loads no external scripts or resources (`script-src 'none'`), can't be framed, and isn't cached, so nothing can scrape the password field.
- Access is **read-only** and you can disconnect any time from your AI app's connector settings.

You may have to sign in again when the Moodle token expires. How long that takes is Reichman's setting; run the probe script below to measure it.

> Your Reichman password is the same one used for email and other university systems. This tool is built to never keep it, but it is unofficial: use it only on your own account, and only if you're comfortable with that.

## Run it locally (personal use)

Reichman's bot protection blocks Moodle API calls from cloud servers, so the hosted version doesn't work today. The local version runs on your own computer, with your own account, through Moodle's official mobile-app API.

```sh
npm install
npm run login      # once; asks for your username + password, saves only the Moodle token
```

Your token and the syllabus cache live in `~/.runi-connector/` (owner-only files). Delete that folder to sign out. Run `npm run login` again if Moodle says your access expired.

**Claude Code** (any project, any terminal):

```sh
claude mcp add --scope user reichman -- "$PWD/node_modules/.bin/tsx" "$PWD/local/server.ts"
```

**Claude Desktop:** add this to `~/Library/Application Support/Claude/claude_desktop_config.json` (replace the path), then restart the app:

```json
{
  "mcpServers": {
    "reichman": {
      "command": "/Users/YOU/repos/runi-connector/node_modules/.bin/tsx",
      "args": ["/Users/YOU/repos/runi-connector/local/server.ts"]
    }
  }
}
```

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
