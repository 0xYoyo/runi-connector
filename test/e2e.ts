// Optional end-to-end smoke test. It drives the Worker (running under `wrangler dev` on
// :8787) the way an AI app would: register a client, open the sign-in page, submit the
// fake student's credentials, exchange the code, then call a tool. Manual by design, since
// it needs two local servers running.
//
// Terminal 1:  npx tsx test/run-mock.ts
// Terminal 2:  npx wrangler dev --config wrangler.e2e.jsonc
// Terminal 3:  npx tsx test/e2e.ts
//
// The automated suite (npm test) already covers the login, Moodle and syllabus logic
// without any servers; this just confirms the OAuth wiring end to end.

import { createHash, randomBytes } from "node:crypto";
import { VALID_USER } from "./mock-reichman";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const REDIRECT = "http://localhost:9999/callback";
const b64url = (buf: Buffer) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const ok = (condition: unknown, label: string) => {
  if (!condition) throw new Error(`FAILED: ${label}`);
  console.log(`✓ ${label}`);
};
const setCookies = (res: Response) =>
  res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

async function main() {
  // Register a client (RFC 7591 dynamic registration).
  const reg = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "E2E Test App",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    }),
  }).then((r) => r.json() as Promise<{ client_id: string }>);
  ok(reg.client_id, `registered client ${reg.client_id}`);

  // PKCE.
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const authUrl = new URL(`${BASE}/authorize`);
  authUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: REDIRECT,
    scope: "courses:read",
    state: "state123",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  // Open the sign-in page and read the handle + security headers.
  const page = await fetch(authUrl, { redirect: "manual" });
  const html = await page.text();
  ok(page.headers.get("content-security-policy")?.includes("script-src 'none'"), "sign-in page forbids scripts");
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  ok(handle, "got a consent handle");

  // Submit credentials to /authorize.
  const form = new URLSearchParams({
    handle: handle!,
    authq: authUrl.search,
    decision: "approve",
    username: VALID_USER.username,
    password: VALID_USER.password,
  });
  const submit = await fetch(authUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: setCookies(page) },
    body: form,
    redirect: "manual",
  });
  const location = submit.headers.get("location");
  ok(location?.startsWith(REDIRECT), "redirected back to the app with a code");
  const code = new URL(location!).searchParams.get("code");

  // Exchange the code for a token.
  const token = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: REDIRECT,
      client_id: reg.client_id,
      code_verifier: verifier,
    }),
  }).then((r) => r.json() as Promise<{ access_token: string }>);
  ok(token.access_token, "exchanged code for an access token");

  // Call a tool.
  const rpc = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token.access_token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_courses", arguments: {} },
    }),
  }).then((r) => r.text());
  ok(rpc.includes("77") || rpc.includes("Algorithms"), "list_courses returned the student's courses");

  console.log("\nAll end-to-end checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
