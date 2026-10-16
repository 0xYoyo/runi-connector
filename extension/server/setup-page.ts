// The sign-in page served locally by the connector. It loads nothing external (own origin
// only), so nothing can scrape the password fields. A small inline script drives the two
// steps and the live verification. The server injects state through a JSON blob.

export interface SetupState {
  nonce: string;
  reichmanConnected: boolean;
  reichmanName: string | null;
  piazzaConnected: boolean;
  suggestedUsername: string;
  storageName: string;
}

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = `
:root{
  --bg:#0f1030; --glow:#2b2d6e;
  --surface:#ffffff; --ink:#14162e; --muted:#5a5f7a; --line:#e6e7f0; --field:#f7f8fc;
  --accent:#4b49e6; --accent-press:#3936c4; --accent-ink:#ffffff;
  --ok:#128a5b; --ok-bg:#e8f6ef; --danger:#c23b2e; --danger-bg:#fdeceb;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#09091c; --glow:#23245a;
  --surface:#171933; --ink:#eef0f8; --muted:#a2a7c4; --line:#2b2e4d; --field:#10122a;
  --accent:#6f6dff; --accent-press:#8785ff; --accent-ink:#0b0b1e;
  --ok:#54d39b; --ok-bg:#122a22; --danger:#ff8f84; --danger-bg:#2c1512;
}}
*{box-sizing:border-box;margin:0}
html{-webkit-text-size-adjust:100%}
body{
  min-height:100vh; padding:24px 16px; color:var(--ink);
  font:16px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Rubik,Arial,sans-serif;
  background:radial-gradient(90% 120% at 50% -10%,var(--glow),var(--bg) 60%);
  display:grid; place-items:center;
}
.card{
  width:100%; max-width:430px; background:var(--surface); border:1px solid var(--line);
  border-radius:20px; padding:34px 30px 28px; box-shadow:0 24px 60px -30px rgba(7,8,30,.7);
}
.brand{display:flex; align-items:center; gap:10px; margin-bottom:26px}
.mark{width:30px;height:30px;border-radius:9px;background:var(--accent);display:grid;place-items:center;flex:none}
.mark span{width:14px;height:2.5px;background:var(--accent-ink);border-radius:2px;box-shadow:0 -4px 0 var(--accent-ink),0 4px 0 var(--accent-ink)}
.brand b{font-size:15px;font-weight:600;letter-spacing:-.01em}
.brand small{display:block;color:var(--muted);font-size:12.5px;font-weight:400}
h1{font-size:25px;line-height:1.15;letter-spacing:-.02em;font-weight:600;margin-bottom:7px}
.lead{color:var(--muted);font-size:14.5px;margin-bottom:22px}
.steps{display:flex;gap:7px;margin-bottom:24px}
.steps i{height:3px;flex:1;border-radius:2px;background:var(--line);transition:background .3s}
.steps i.on{background:var(--accent)}
.steps i.done{background:var(--ok)}
label{display:block;font-size:13.5px;font-weight:550;margin:0 0 7px}
.field{margin-bottom:16px}
input{
  width:100%;padding:12px 13px;font-size:16px;color:var(--ink);background:var(--field);
  border:1.5px solid var(--line);border-radius:11px;outline:none;transition:border-color .15s
}
input:focus{border-color:var(--accent)}
input[dir=ltr]{text-align:left}
.hint{font-size:12.5px;color:var(--muted);margin:-9px 0 16px}
.btn{
  width:100%;padding:13px;font-size:15.5px;font-weight:600;border:none;border-radius:11px;cursor:pointer;
  background:var(--accent);color:var(--accent-ink);transition:background .15s;display:flex;gap:9px;align-items:center;justify-content:center
}
.btn:hover{background:var(--accent-press)}
.btn:disabled{opacity:.55;cursor:default}
.btn.ghost{background:transparent;color:var(--muted);font-weight:500;margin-top:4px}
.btn.ghost:hover{color:var(--ink)}
.spin{width:16px;height:16px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:sp .7s linear infinite;display:none}
@keyframes sp{to{transform:rotate(360deg)}}
.loading .spin{display:inline-block}
.loading .label{opacity:.7}
.note{display:flex;gap:9px;align-items:flex-start;font-size:12.5px;color:var(--muted);margin-top:20px;padding-top:18px;border-top:1px solid var(--line)}
.note svg{flex:none;margin-top:1px;color:var(--ok)}
.msg{font-size:13.5px;border-radius:10px;padding:10px 12px;margin-bottom:16px;display:none}
.msg.err{display:block;background:var(--danger-bg);color:var(--danger)}
.msg.ok{display:block;background:var(--ok-bg);color:var(--ok)}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--ok);font-weight:550}
.pill.off{color:var(--muted);font-weight:400}
.row{display:flex;align-items:center;justify-content:space-between;padding:15px 0;border-bottom:1px solid var(--line)}
.row:last-of-type{border-bottom:none}
.row .who{font-size:14px}
.row .who small{display:block;color:var(--muted);font-size:12.5px}
.foot{font-size:11.5px;color:var(--muted);text-align:center;margin-top:20px}
[hidden]{display:none!important}`;

const LOCK = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;
const CHECK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5"/></svg>`;

export function setupPage(state: SetupState): string {
  const json = escape(JSON.stringify(state));
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Reichman Courses</title><style>${STYLE}</style></head>
<body>
<main class="card" id="card">
  <div class="brand">
    <div class="mark"><span></span></div>
    <div><b>Reichman Courses</b><small>Unofficial · read-only · runs on your computer</small></div>
  </div>

  <div class="steps"><i id="s1"></i><i id="s2"></i></div>

  <!-- Step 1: Reichman -->
  <section id="step-reichman">
    <h1>Connect your Reichman account</h1>
    <p class="lead">Sign in once so Claude can see your Moodle courses, syllabi, deadlines, lectures and grades.</p>
    <div class="msg" id="r-msg"></div>
    <form id="r-form" autocomplete="on">
      <div class="field">
        <label for="r-user">Username</label>
        <input id="r-user" name="username" dir="ltr" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="first.last" required>
      </div>
      <p class="hint">The username you use for Moodle / My RUNI, usually your first and last name with a dot.</p>
      <div class="field">
        <label for="r-pass">Password</label>
        <input id="r-pass" name="password" type="password" dir="ltr" autocomplete="current-password" required>
      </div>
      <button class="btn" id="r-btn" type="submit"><span class="spin"></span><span class="label">Connect</span></button>
    </form>
    <div class="note">${LOCK}<span>Your password is checked against Reichman's own login, then kept in ${escape(state.storageName)}. It never leaves your computer except to sign in to Reichman.</span></div>
  </section>

  <!-- Step 2: Piazza -->
  <section id="step-piazza" hidden>
    <h1>Add Piazza <span style="color:var(--muted);font-weight:500;font-size:16px">· optional</span></h1>
    <p class="lead">Recommended. Piazza has a separate login, so add it to let Claude search your classes' Q&amp;A, notes and announcements.</p>
    <div class="msg" id="p-msg"></div>
    <form id="p-form" autocomplete="on">
      <div class="field">
        <label for="p-email">Piazza email</label>
        <input id="p-email" name="email" type="email" dir="ltr" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="first.last@post.runi.ac.il" required>
      </div>
      <div class="field">
        <label for="p-pass">Piazza password</label>
        <input id="p-pass" name="password" type="password" dir="ltr" autocomplete="current-password" required>
      </div>
      <button class="btn" id="p-btn" type="submit"><span class="spin"></span><span class="label">Connect Piazza</span></button>
      <button class="btn ghost" id="p-skip" type="button">Skip for now</button>
    </form>
  </section>

  <!-- Done / status -->
  <section id="step-done" hidden>
    <h1 id="done-title">You're all set</h1>
    <p class="lead" id="done-lead">Close this tab and head back to your chat.</p>
    <div class="row">
      <div class="who">Reichman<small id="done-name"></small></div>
      <div class="pill" id="done-reichman">${CHECK} Connected</div>
    </div>
    <div class="row">
      <div class="who">Piazza<small>Class Q&amp;A and notes</small></div>
      <div class="pill off" id="done-piazza">Not connected</div>
    </div>
    <button class="btn ghost" id="done-piazza-btn" type="button" hidden>Add Piazza</button>
    <p class="foot">Not affiliated with Reichman University. You can close this tab any time.</p>
  </section>
</main>

<script>
const S = JSON.parse(document.getElementById('seed').textContent);
const $ = (id) => document.getElementById(id);
const show = (which) => {
  for (const s of ['reichman','piazza','done']) $('step-' + s).hidden = (s !== which);
  $('s1').className = which === 'reichman' ? 'on' : 'done';
  $('s2').className = which === 'piazza' ? 'on' : (which === 'done' && S.piazzaConnected ? 'done' : '');
};
const suggestPiazza = (user) => user ? user + '@post.runi.ac.il' : '';

async function post(path, body, btn, msg) {
  msg.className = 'msg'; btn.classList.add('loading'); btn.disabled = true;
  try {
    const r = await fetch(path, { method:'POST', headers:{'Content-Type':'application/json','X-Setup-Nonce':S.nonce}, body: JSON.stringify(body) });
    const data = await r.json();
    if (!data.ok) { msg.className = 'msg err'; msg.textContent = data.error || 'Something went wrong.'; return null; }
    return data;
  } catch (e) {
    msg.className = 'msg err'; msg.textContent = 'Could not reach the connector. Is the app still open?'; return null;
  } finally { btn.classList.remove('loading'); btn.disabled = false; }
}

$('r-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = await post('/verify-reichman', { username: $('r-user').value.trim(), password: $('r-pass').value }, $('r-btn'), $('r-msg'));
  if (!data) return;
  S.reichmanConnected = true; S.reichmanName = data.name; S.suggestedUsername = $('r-user').value.trim();
  $('p-email').value = suggestPiazza(S.suggestedUsername);
  renderDone(); show('piazza'); $('p-pass').focus();
});

$('p-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = await post('/verify-piazza', { email: $('p-email').value.trim(), password: $('p-pass').value }, $('p-btn'), $('p-msg'));
  if (!data) return;
  S.piazzaConnected = true; renderDone(); show('done');
});
$('p-skip').addEventListener('click', () => { renderDone(); show('done'); });
$('done-piazza-btn').addEventListener('click', () => { $('p-msg').className='msg'; show('piazza'); $('p-email').focus(); });

function renderDone() {
  $('done-name').textContent = S.reichmanName ? 'Signed in as ' + S.reichmanName : '';
  $('done-reichman').innerHTML = ${JSON.stringify(CHECK)} + ' Connected';
  const p = $('done-piazza');
  p.className = 'pill' + (S.piazzaConnected ? '' : ' off');
  p.innerHTML = S.piazzaConnected ? ${JSON.stringify(CHECK)} + ' Connected' : 'Not connected';
  $('done-piazza-btn').hidden = S.piazzaConnected;
  $('done-title').textContent = "You're all set";
  $('done-lead').textContent = S.piazzaConnected ? 'Close this tab and head back to your chat.' : 'Reichman is connected. Add Piazza now or any time later.';
}

// Initial view.
$('r-user').value = S.suggestedUsername || '';
if (S.reichmanConnected) { renderDone(); show('done'); } else { show('reichman'); $('r-user').focus(); }
</script>
<script type="application/json" id="seed">${json}</script>
</body></html>`;
}
