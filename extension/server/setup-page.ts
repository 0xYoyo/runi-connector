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
  piazzaEmail?: string;
  reichmanNotice?: string; // shown on the Reichman step, e.g. "your saved password stopped working"
  piazzaNotice?: string;
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

const EYE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a17.5 17.5 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>`;

const EXTRA_STYLE = `
.pw{position:relative}
.pw input{padding-right:46px}
.eye{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:36px;height:36px;border:none;background:transparent;color:var(--muted);border-radius:8px;cursor:pointer;display:grid;place-items:center}
.eye:hover{color:var(--ink)}
.eye:focus-visible,.btn:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
`;

function passwordField(id: string, label: string, autocomplete: string) {
  return `<div class="field">
        <label for="${id}">${label}</label>
        <div class="pw">
          <input id="${id}" name="password" type="password" dir="ltr" autocomplete="${autocomplete}" required>
          <button class="eye" type="button" data-for="${id}" aria-label="Show password" aria-pressed="false">${EYE}</button>
        </div>
      </div>`;
}

export function setupPage(state: SetupState): string {
  // JSON for the script, made safe to embed inside a <script> element.
  const seed = JSON.stringify(state).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Reichman Courses</title><style>${STYLE}${EXTRA_STYLE}</style></head>
<body>
<main class="card" id="card">
  <div class="brand">
    <div class="mark"><span></span></div>
    <div><b>Reichman Courses</b><small>Unofficial · read-only · runs on your computer</small></div>
  </div>

  <div class="steps" aria-hidden="true"><i id="s1"></i><i id="s2"></i></div>

  <section id="step-reichman">
    <h1>Connect your Reichman account</h1>
    <p class="lead">Sign in once so Claude can see your Moodle courses, syllabi, deadlines, lectures and grades.</p>
    <div class="msg" id="r-msg" role="alert"></div>
    <form id="r-form" method="post" action="/no-script" autocomplete="on" novalidate>
      <div class="field">
        <label for="r-user">Username</label>
        <input id="r-user" name="username" dir="ltr" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="first.last" required>
      </div>
      <p class="hint">The username you use for Moodle and My RUNI, usually first.last.</p>
      ${passwordField("r-pass", "Password", "current-password")}
      <button class="btn" id="r-btn" type="submit"><span class="spin"></span><span class="label">Connect</span></button>
    </form>
    <div class="note">${LOCK}<span>Checked with Reichman's own login, then saved in ${escape(state.storageName)}. It's only ever sent to Reichman.</span></div>
  </section>

  <section id="step-piazza" hidden>
    <h1>Add Piazza <span style="color:var(--muted);font-weight:500;font-size:16px">· optional</span></h1>
    <p class="lead">Recommended. Piazza has its own login. Add it so Claude can search your classes' questions, notes and announcements.</p>
    <div class="msg" id="p-msg" role="alert"></div>
    <form id="p-form" method="post" action="/no-script" autocomplete="on" novalidate>
      <div class="field">
        <label for="p-email">Piazza email</label>
        <input id="p-email" name="email" type="email" dir="ltr" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="first.last@post.runi.ac.il" required>
      </div>
      ${passwordField("p-pass", "Piazza password", "current-password")}
      <button class="btn" id="p-btn" type="submit"><span class="spin"></span><span class="label">Connect Piazza</span></button>
      <button class="btn ghost" id="p-skip" type="button">Skip for now</button>
    </form>
  </section>

  <section id="step-done" hidden>
    <h1 id="done-title">You're all set</h1>
    <p class="lead" id="done-lead">Close this tab and head back to your chat.</p>
    <div class="row">
      <div class="who">Reichman<small id="done-name"></small></div>
      <div class="pill" id="done-reichman">${CHECK} Connected</div>
    </div>
    <div class="row">
      <div class="who">Piazza<small>Class questions and notes</small></div>
      <div class="pill off" id="done-piazza">Not connected</div>
    </div>
    <button class="btn ghost" id="done-piazza-btn" type="button" hidden>Add Piazza</button>
    <button class="btn ghost" id="done-change-btn" type="button">Use a different Reichman account</button>
    <p class="foot">Not affiliated with Reichman University.</p>
  </section>
</main>

<script type="application/json" id="seed">${seed}</script>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var S;
  try { S = JSON.parse($('seed').textContent); } catch (e) { S = null; }
  var forms = [$('r-form'), $('p-form')];
  // Never let the browser submit these forms itself (that would put fields in a request we don't want).
  forms.forEach(function (f) { f.addEventListener('submit', function (e) { e.preventDefault(); }); });
  if (!S) { $('r-msg').className = 'msg err'; $('r-msg').textContent = 'This page failed to load. Close it and ask Claude to connect your account again.'; return; }

  var CHECK = ${JSON.stringify(CHECK)};
  var EYE = ${JSON.stringify(EYE)}, EYE_OFF = ${JSON.stringify(EYE_OFF)};

  document.querySelectorAll('.eye').forEach(function (b) {
    b.addEventListener('click', function () {
      var input = $(b.getAttribute('data-for'));
      var showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      b.innerHTML = showing ? EYE : EYE_OFF;
      b.setAttribute('aria-pressed', String(!showing));
      b.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
      input.focus();
    });
  });

  function show(which) {
    ['reichman', 'piazza', 'done'].forEach(function (s) { $('step-' + s).hidden = s !== which; });
    $('s1').className = which === 'reichman' ? 'on' : 'done';
    $('s2').className = which === 'piazza' ? 'on' : (which === 'done' && S.piazzaConnected ? 'done' : '');
  }
  function setMsg(el, kind, text) { el.className = kind ? 'msg ' + kind : 'msg'; el.textContent = text || ''; }

  function post(path, body, btn, msg, busyLabel) {
    setMsg(msg, '', '');
    var label = btn.querySelector('.label'), idle = label.textContent;
    btn.classList.add('loading'); btn.disabled = true; label.textContent = busyLabel;
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Setup-Nonce': S.nonce }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (data) { if (!data.ok) { setMsg(msg, 'err', data.error || 'Something went wrong. Try again.'); return null; } return data; })
      .catch(function () { setMsg(msg, 'err', "Can't reach the connector. Make sure Claude is open, then try again."); return null; })
      .finally(function () { btn.classList.remove('loading'); btn.disabled = false; label.textContent = idle; });
  }

  $('r-form').addEventListener('submit', function () {
    var user = $('r-user').value.trim(), pass = $('r-pass').value;
    if (!user || !pass) { setMsg($('r-msg'), 'err', 'Enter your username and password.'); (user ? $('r-pass') : $('r-user')).focus(); return; }
    post('/verify-reichman', { username: user, password: pass }, $('r-btn'), $('r-msg'), 'Checking with Reichman…').then(function (data) {
      if (!data) { $('r-pass').select(); return; }
      S.reichmanConnected = true; S.reichmanName = data.name || null; S.suggestedUsername = user;
      $('r-pass').value = '';
      if (S.piazzaConnected) { renderDone(); show('done'); return; }
      if (!$('p-email').value) $('p-email').value = S.piazzaEmail || user + '@post.runi.ac.il';
      show('piazza'); $('p-pass').focus();
    });
  });

  $('p-form').addEventListener('submit', function () {
    var email = $('p-email').value.trim(), pass = $('p-pass').value;
    if (!email || !pass) { setMsg($('p-msg'), 'err', 'Enter your Piazza email and password, or skip for now.'); return; }
    post('/verify-piazza', { email: email, password: pass }, $('p-btn'), $('p-msg'), 'Checking with Piazza…').then(function (data) {
      if (!data) { $('p-pass').select(); return; }
      S.piazzaConnected = true; $('p-pass').value = ''; renderDone(); show('done');
    });
  });

  $('p-skip').addEventListener('click', function () { renderDone(); show('done'); });
  $('done-piazza-btn').addEventListener('click', function () { setMsg($('p-msg'), '', ''); if (!$('p-email').value) $('p-email').value = S.piazzaEmail || (S.suggestedUsername ? S.suggestedUsername + '@post.runi.ac.il' : ''); show('piazza'); $('p-pass').focus(); });
  $('done-change-btn').addEventListener('click', function () { setMsg($('r-msg'), '', ''); show('reichman'); $('r-user').select(); });

  function renderDone() {
    $('done-name').textContent = S.reichmanName ? 'Signed in as ' + S.reichmanName : (S.suggestedUsername ? 'Signed in as ' + S.suggestedUsername : '');
    $('done-reichman').innerHTML = CHECK + ' Connected';
    var p = $('done-piazza');
    p.className = 'pill' + (S.piazzaConnected ? '' : ' off');
    p.innerHTML = S.piazzaConnected ? CHECK + ' Connected' : 'Not connected';
    $('done-piazza-btn').hidden = !!S.piazzaConnected;
    $('done-lead').textContent = S.piazzaConnected ? 'Close this tab and head back to your chat.' : 'Reichman is connected. You can add Piazza now or any time later.';
  }

  $('r-user').value = S.suggestedUsername || '';
  if (S.reichmanNotice) setMsg($('r-msg'), 'err', S.reichmanNotice);
  if (S.piazzaNotice) { setMsg($('p-msg'), 'err', S.piazzaNotice); }
  if (S.reichmanConnected && S.piazzaNotice) { $('p-email').value = S.piazzaEmail || (S.suggestedUsername ? S.suggestedUsername + '@post.runi.ac.il' : ''); show('piazza'); $('p-pass').focus(); }
  else if (S.reichmanConnected) { renderDone(); show('done'); } else { show('reichman'); ($('r-user').value ? $('r-pass') : $('r-user')).focus(); }
})();
</script>
</body></html>`;
}
