# Hosted native connector feasibility

Research date: 2026-11-09. Baseline: 36f825c. Branch: research/hosted-native-connectors.
Status: architecture and platform research; no hosted Reichman login verified, no deployment.

## Decision

Build one remotely hosted Streamable HTTP MCP service with OAuth, reusable across LLM clients. Test an actual Chromium login in a hosted environment before committing to a hosting provider or promising availability. The earlier Cloudflare failure does not demonstrate that every hosted environment fails.

The owner reports IT has approved the integration and suggested finding an interim approach. That updates the earlier assumption that investigation must wait for IT. Scope remains each consenting student's own read-only data.

## Why the existing attempt is inconclusive

src/browser.ts is a fetch client with a cookie jar and HTML form parser, despite its browser name. It does not execute JavaScript. The project records HTTP 247 JavaScript challenges from Reblaze on Cloudflare egress. A genuine hosted browser is materially different, but can still be blocked. Another service reportedly working is useful motivation, not evidence of its network, permissions, or implementation.

## Proposed architecture

LLM native connector -> OAuth-protected hosted MCP -> per-user session broker -> Reichman APIs.

A real hosted browser handles initial SSO and, when needed, reauthentication. Prefer temporary password handling and encrypted persisted university sessions/tokens. Keep LLM OAuth tokens separate from university credentials. Do not expose passwords or university bearer tokens to LLM clients. Disable login recordings, traces and form persistence; isolate users and implement revoke/delete.

First try ordinary API requests from the same hosting environment after browser login. If the university requires browser-bound session state, evaluate API requests within the authenticated browser context. Token validity alone does not establish network access. Never assume cookies or challenge clearance transfer to a different host. Keep the browser on demand where possible; avoid a permanently running browser per student.

Browserbase Contexts demonstrate that managed cloud browsers can persist authenticated sessions. This is an example capability, not a verified Reichman-compatible provider or a purchase recommendation. Self-hosted Chromium is another option. A plain Node server may also work without a browser on an allowed network, but that needs testing.

The existing Worker can remain an OAuth/MCP front door if university requests are delegated to the hosted session service. Existing Moodle tool logic can be reused. Panopto/Michlol/Piazza providers and refresh handling must be wired separately; current Worker omits them. A browser-backed transport is not automatically a drop-in replacement for the existing custom Browser.

## Platform findings

- Claude: remote custom connectors work through Anthropic's cloud, including mobile. Initial custom setup currently requires entering the server URL and completing consent; directory distribution is the cleaner broad-release experience.
- Claude Code: connectors added and authenticated on claude.ai are automatically available when signed in using a claude.ai subscription account; API-key and third-party-provider modes differ. Students need not install a local npm server.
- ChatGPT: remotely backed plugins support web, desktop and mobile; desktop-only packaging must be avoided. Custom MCP setup and public plugin distribution are distinct. Account/workspace eligibility, consent and review still apply.
- Gemini Apps: native custom MCP supports web and mobile after setup on web, but current documentation restricts it to US adults, personal Google accounts, English and Keep Activity enabled. Do not advertise this as available to students in Israel. Gemini CLI is not equivalent to Gemini Apps support.

One-click is a product target, not a universal protocol feature. A website can link to real platform install listings when available; do not invent installation deep links. During a pilot, copying one server URL plus sign-in is realistic. Public directory approval and distribution need separate validation for each platform.

## Experiment and release gates

1. Select a hosted test environment; test ordinary navigation to Moodle/SSO without credentials and record only response class, challenge presence and timing.
2. Have the owner interactively sign in to their own account; never pass passwords on command lines or in chat. Verify Moodle site identity and one course listing.
3. Test direct API requests from the same host, then browser-context requests if necessary. Compare results without moving secrets into logs.
4. Restart the worker/browser and verify encrypted session restoration; measure expiry and reauthentication rather than promising permanent sign-in.
5. Test two consenting users for strict data isolation, disconnect/revoke, concurrent calls and rate limits. Verify Panopto and Michlol separately.
6. Measure browser runtime, cold-start latency, requests and storage to establish operating cost. No reliable cost estimate until these are measured.
7. Exercise OAuth initialization, discovery, tools/list and a real tool call in Claude, ChatGPT and mobile clients. Start a small beta before directory submission.

If ordinary hosted browsing is blocked too, record the result and use IT to arrange a permitted route. Do not promise that changing providers, adding a proxy, or deploying the existing Worker fixes it.

## Sources

- https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- https://code.claude.com/docs/en/mcp#use-mcp-servers-from-claude-ai
- https://learn.chatgpt.com/docs/plugins
- https://developers.openai.com/plugins/deploy/connect-chatgpt
- https://support.google.com/gemini/answer/17209137?hl=en-SY
- https://developers.google.com/connected-apps/mcp/dev-mode/usage
- https://docs.browserbase.com/platform/browser/core-features/contexts
