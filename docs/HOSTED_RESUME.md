# Hosted connector implementation checkpoint

Updated 2026-11-09. Product unfinished; do not distribute as ready.

## User objective

Deliver a hosted native connector for Claude and ChatGPT first. Students should install/connect, sign in and use desktop/web/mobile without a running personal computer. Gemini deferred. Keep stable Claude desktop version intact. User wants no monthly hosting costs; no paid plan/service has been authorized. User anticipates a usage-limit interruption and will return to resume.

## Checkout

Branch research/hosted-native-connectors, isolated worktree:
/Users/yoyopc/.codex/worktrees/runi-hosted-research/runi-connector
Original /Users/yoyopc/repos/runi-connector remains on main. Research commit b171a9a.
node_modules is a local ignored symlink to the original checkout's existing dependencies.

## Verified

- Existing Cloudflare Wrangler OAuth login is valid and includes browser write scope.
- Account ID: 4e811ddbe3d469bf53b6d26bc8e89bdc. Not a credential.
- GET account subscriptions returned HTTP 403; billing plan cannot be verified with this token.
- No browser-hosting environment variables were present.
- Cloudflare browser free allowance documented as 10 minutes/day and 3 concurrent browsers on 2026-11-09: https://developers.cloudflare.com/browser-run/pricing/
- No browser-time request has been made. No paid subscription, deployment, public endpoint or account change created.
- Async question pending: is the existing account Workers Free, or is a brief test on a paid account okay? Do not treat elapsed time as approval.

## Added

scripts/hosted/probe.py: one bounded, unauthenticated Cloudflare browser navigation to the university login page; no university credentials, no response HTML/cookies/token logging, and no configuration changes. Explicit budget acknowledgement required. Reads Wrangler OAuth credential privately or CLOUDFLARE_API_TOKEN. Emits only classifier signals. Challenge detection is heuristic; a login-looking page is NOT proof of working authentication.
scripts/hosted/test_probe.py: four unit tests pass (login detection, challenge precedence, inconclusive handling, output redaction).

## Next steps

1. Resolve pending free-plan/budget answer. If approved, run:
   python3 scripts/hosted/probe.py --account-id 4e811ddbe3d469bf53b6d26bc8e89bdc --confirm-browser-budget
2. Save sanitized outcome. Provider errors (401/403 etc.) are not evidence of a Reichman block. Investigate provider access separately.
3. If ordinary hosted browsing reaches SSO, implement/test interactive owner sign-in and session restoration. Never retrieve the user's saved university password and silently upload it to a new provider. Never request passwords in chat or CLI args.
4. Validate a real course query from the SAME host/session before building a multi-user hosted release. Need authentication test with owner participation. Reuse existing API tool code, connect missing Panopto/Michlol providers after Moodle works.
5. Add per-user encrypted session store, OAuth separation, revocation/delete, isolation tests, bounded browser lifetime, request quotas and strict free-budget controls. No promise of indefinite free operation or perpetual sign-in.
6. Test installed native flows on Claude + ChatGPT, including mobile, with two consenting accounts. Directory install distribution is a separate launch gate.

Read HOSTED_CONNECTOR_RESEARCH.md for sources and architecture. User reports IT approved an interim approach. Existing no-evasion instructions should not be interpreted as a ban on investigating ordinary authorized cloud browser login; no stealth/proxy/challenge-bypass implementation has been added.

## Resume test results — 2026-11-09

- Browser UI verified Workers plans -> Free -> Current plan ($0). No upgrade performed.
- Cloudflare real-browser API succeeded. Ordinary Moodle login yielded a 575–579-byte script-only page, including kramericaindustries.ac_v2.lib.js and rbz signals. Still present after a 10-second wait.
- Exact admin/tool/mobile/launch.php route also returned challenge_signals after a 5-second wait, no password form or SSO signals. No university credentials submitted.
- This disproves the assumption that adding a Cloudflare real browser alone fixes access. It does NOT prove all hosting networks fail.
- Probe classifier now detects the actual script-only challenge; 5 Python regression tests pass.
- Original baseline: 19 tests pass, 9 skipped.
- Next candidate is an ordinary browser on a different hosted environment, with no stealth/bypass features. Render Free can be a bounded experiment but is explicitly not a production guarantee: sleeps after 15 minutes, shared 750 hours/month, ephemeral filesystem, bandwidth/build overage risks if a payment method exists. Verify account spending controls before provisioning. Source https://render.com/docs/free . Do not promise a flawless always-on service for zero hosting cost.
- Product still NOT release-ready. Need actual hosted authenticated API success, account isolation and refresh tests, native integration verification, and a sustainable hosting decision before release.
