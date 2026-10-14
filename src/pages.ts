import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

export const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const STYLE = `
:root{--bg:#f5f6f8;--card:#fff;--ink:#16181d;--muted:#5b6170;--line:#dfe2e8;--accent:#1f3a8a;--accent-ink:#fff;--warn:#8a4b00;--warn-bg:#fff4e0;--err:#9b1c1c;--err-bg:#fdecec}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--ink:#eef0f4;--muted:#a3a9b6;--line:#2a2f3a;--accent:#7c9cff;--accent-ink:#0f1115;--warn:#ffcc80;--warn-bg:#2b2112;--err:#ffb4b4;--err-bg:#2c1414}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px}
main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:20px;margin:0 0 4px}p{margin:0 0 14px;color:var(--muted)}.small{font-size:13px}
.box{border-radius:10px;padding:10px 12px;margin:0 0 16px;font-size:14px}.warn{background:var(--warn-bg);color:var(--warn)}.err{background:var(--err-bg);color:var(--err)}
label{display:block;font-weight:600;font-size:14px;margin:14px 0 6px}
input[type=text],input[type=password]{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--ink);font-size:15px}
.row{display:flex;gap:10px;margin-top:20px}button{flex:1;padding:11px;border-radius:8px;border:1px solid var(--line);font-size:15px;font-weight:600;cursor:pointer;background:transparent;color:var(--ink)}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
ul{padding-inline-start:18px;margin:0 0 14px;color:var(--muted);font-size:13px}`;

export function signInPage(details: ConsentDescription, handle: string, options: { error?: string; username?: string; authQuery?: string } = {}) {
  const clientName = escapeHtml(details.clientName);
  const verified = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "The app's name is self-reported and not verified.";
  const loopbackWarning = details.redirectIsLoopback
    ? `<div class="box warn">This sends access to an app on your own computer. Continue only if you just started connecting from it.</div>`
    : "";
  const error = options.error ? `<div class="box err" role="alert">${escapeHtml(options.error)}</div>` : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Reichman courses</title><style>${STYLE}</style></head>
<body><main>
<h1>Connect your Reichman courses</h1>
<p><strong>${clientName}</strong> wants read access to your Moodle courses and syllabi. ${verified} Access goes to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopbackWarning}${error}
<form method="post" autocomplete="on">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <input type="hidden" name="authq" value="${escapeHtml(options.authQuery ?? "")}">
  <label for="username">Reichman username</label>
  <input id="username" name="username" type="text" autocomplete="username" required value="${escapeHtml(options.username ?? "")}" dir="ltr">
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required dir="ltr">
  <div class="row">
    <button type="submit" name="decision" value="deny" formnovalidate>Cancel</button>
    <button type="submit" name="decision" value="approve" class="primary">Connect</button>
  </div>
</form>
<ul style="margin-top:18px">
  <li>Your password is used once, to sign in to the university login page, and is never stored.</li>
  <li>What's kept is a Moodle access token, encrypted so only your connected app can use it.</li>
  <li>Read-only. Disconnect any time from your AI app's connector settings.</li>
</ul>
<p class="small">Unofficial student project, not affiliated with Reichman University.</p>
</main></body></html>`;
}

export function messagePage(title: string, message: string, status = 400) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export function landingPage(publicUrl: string) {
  return messagePage(
    "Reichman courses connector",
    `Add ${publicUrl}/mcp as a custom connector in Claude, ChatGPT, Codex or Gemini, then sign in with your Reichman account. Unofficial student project.`,
    200,
  );
}
