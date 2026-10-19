// A fake Reichman: Moodle (SAML-protected, with a mobile launch.php and REST API),
// an F5-style login page acting as the identity provider, and the syllabus generator.
// Everything lives on one local port under different path prefixes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const VALID_USER = { username: "student1", password: "correct-horse" };
export const VALID_PIAZZA = { email: "student1@post.runi.ac.il", password: "piazza-pass" };
export const MOODLE_TOKEN = "0123456789abcdef0123456789abcdef"; // gitleaks:allow (fake test token)

function cookies(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    (req.headers.cookie ?? "")
      .split(";")
      .map((c) => c.trim().split("="))
      .filter((p) => p[0]),
  );
}

async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

async function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readRaw(req));
}

export function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 50 750 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

const loginForm = (error = "") => `<!doctype html><html><head><title>Reichman login</title></head><body>
${error ? `<p class="err">${error}</p>` : ""}
<form method="post" action="/idp/my.policy">
  <input type="hidden" name="vhost" value="standard">
  <input type="text" name="username" value="">
  <input type="password" name="password" value="">
  <input type="submit" value="Login">
</form></body></html>`;

// Reichman's real wrong-password page (live: auth.runi.ac.il/vdesk/hangup.php3).
const DENIED_PAGE = `<!doctype html><html><head><title>Reichman University - Logout</title></head><body>
<p>אוניברסיטת רייכמן - התחברות</p><p>אחד או יותר מפרטי ההזדהות שמסרת שגויים.</p>
<p>כדי להתחיל פעילות מחדש, בבקשה לחץ כאן להמשך</p><a href="/">לחץ כאן להמשך</a></body></html>`;

const ACCESS_NOT_FOUND = `<html><head><title>IDC-Herzliya - access not found</title></head><body><p>לצערנו משהו השתבש...</p><a href="/">לחצו כאן להתחברות מחדש</a></body></html>`;

// The page My RUNI shows when a session is gone (seen live).
const LOGGED_OUT_PAGE = `<!doctype html><html><head><title>Reichman University</title></head><body>
<p>בוצעה התנתקות</p><a href="/">לחץ כאן להמשך</a></body></html>`;

const passwordAttempts: string[] = []; // every password the fake login server received
export function receivedPasswords() {
  return passwordAttempts;
}

export function startMockReichman(
  port = 0,
  options: { requireMfa?: boolean; wrongPasswordShowsForm?: boolean } = {},
): Promise<{ server: Server; base: string }> {
  const sessions = new Set<string>(); // moodle sessions
  const idpSessions = new Set<string>();
  // My RUNI gateway sessions. Like the real one (seen live 2026-10-19), a session is tied to the
  // service it was opened for; reusing it for another service gets "access not found".
  const gateway = new Map<string, "yedion" | "panopto">();
  const yedionSessions = new Set<string>();
  const panoptoSessions = new Set<string>();
  const piazzaSessions = new Map<string, string>(); // session -> csrf

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const jar = cookies(req);
    const send = (status: number, body: string | Buffer, headers: Record<string, string | string[]> = {}) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...headers });
      res.end(body);
    };
    const redirect = (location: string, headers: Record<string, string | string[]> = {}) =>
      send(303, "", { Location: location, ...headers });
    const base = `http://${req.headers.host}`;
    const moodleLoggedIn = jar.MoodleSession && sessions.has(jar.MoodleSession);

    // ---------- Moodle ----------
    if (url.pathname === "/moodle/admin/tool/mobile/launch.php") {
      if (!moodleLoggedIn) {
        return redirect(`/moodle/login/index.php`, { "Set-Cookie": `MoodleWants=${encodeURIComponent(url.toString())}; Path=/` });
      }
      const passport = url.searchParams.get("passport");
      const payload = Buffer.from(`fakesignature${passport}:::${MOODLE_TOKEN}:::privatetoken`).toString("base64");
      return redirect(`moodlemobile://token=${payload}`);
    }
    if (url.pathname === "/moodle/login/index.php") {
      return send(200, `<html><head><title>Moodle: Log in</title></head><body>
        <a href="/moodle/auth/saml2/login.php?wants=x&amp;idp=abc&amp;passive=off">SAML Login</a></body></html>`);
    }
    if (url.pathname === "/moodle/auth/saml2/login.php") {
      return redirect(`/idp/sso?SAMLRequest=abc&RelayState=xyz`);
    }
    if (url.pathname === "/moodle/auth/saml2/sp/saml2-acs.php" && req.method === "POST") {
      const body = await readBody(req);
      if (body.get("SAMLResponse") !== "signed-assertion") return send(400, "bad assertion");
      const sid = crypto.randomUUID();
      sessions.add(sid);
      const wants = decodeURIComponent(jar.MoodleWants ?? `${base}/moodle/`);
      return redirect(wants, { "Set-Cookie": `MoodleSession=${sid}; Path=/moodle; HttpOnly` });
    }
    if (url.pathname === "/moodle/course/view.php") {
      if (!moodleLoggedIn) return redirect("/moodle/login/index.php");
      const id = url.searchParams.get("id");
      const links =
        id === "2701328"
          ? `<a href="https://syllabus.runi.ac.il/pdf/renderdocument?SectionIDC=1813792">271007701</a>
             <a href="https://syllabus.runi.ac.il/pdf/renderdocument?SectionIDC=1813793">271007702</a>`
          : "";
      return send(200, `<html><body><h1>Course ${id}</h1>${links}</body></html>`);
    }
    if (url.pathname === "/moodle/webservice/rest/server.php") {
      const body = await readBody(req);
      if (body.get("wstoken") !== MOODLE_TOKEN) {
        return send(200, JSON.stringify({ exception: "moodle_exception", errorcode: "invalidtoken", message: "Invalid token" }), {
          "Content-Type": "application/json",
        });
      }
      const fn = body.get("wsfunction");
      const json = (data: unknown) => send(200, JSON.stringify(data), { "Content-Type": "application/json" });
      if (fn === "core_webservice_get_site_info") return json({ userid: 42, fullname: "Test Student", sitename: "Moodle2027" });
      if (fn === "core_enrol_get_users_courses")
        return json([
          { id: 2701328, fullname: "אלגוריתמים", shortname: "Algorithms-77-2027/1 - 2701328" },
          { id: 2700703, fullname: "תכנות מתקדם", shortname: "Advanced Programming-3030-2027/1 - 2700703" },
        ]);
      if (fn === "core_course_get_contents")
        return json([
          {
            id: 1,
            name: "Lecture Notes",
            summary: "<p>Slides for each week</p>",
            modules: [
              {
                id: 11,
                name: "Week 1 - Graphs",
                modname: "resource",
                url: `${base}/moodle/mod/resource/view.php?id=11`,
                contents: [{ type: "file", filename: "week1-graphs.pdf", filesize: 2048, fileurl: `${base}/moodle/webservice/pluginfile.php/1/mod_resource/content/0/week1-graphs.pdf` }],
              },
            ],
          },
        ]);
      if (fn === "core_calendar_get_action_events_by_timesort")
        return json({ events: [{ name: "HW1 is due", timesort: Math.floor(Date.now() / 1000) + 86400, course: { fullname: "אלגוריתמים" } }] });
      if (fn === "gradereport_user_get_grade_items")
        return json({ usergrades: [{ gradeitems: [{ itemname: "HW1", itemtype: "mod", gradeformatted: "95.00", rangeformatted: "0–100", percentageformatted: "95.00 %", feedback: "" }] }] });
      return json({ exception: "x", errorcode: "unknownfunction", message: `mock has no ${fn}` });
    }
    if (url.pathname.startsWith("/moodle/webservice/pluginfile.php/")) {
      if (url.searchParams.get("token") !== MOODLE_TOKEN) return send(403, "nope");
      return send(200, minimalPdf("Week 1: BFS and DFS on graphs"), { "Content-Type": "application/pdf" });
    }

    // ---------- Identity provider (F5-like) ----------
    if (url.pathname === "/idp/sso") {
      if (jar.MRHSession && idpSessions.has(jar.MRHSession)) {
        return send(200, `<html><body onload="document.forms[0].submit()">
          <form method="post" action="${base}/moodle/auth/saml2/sp/saml2-acs.php">
          <input type="hidden" name="SAMLResponse" value="signed-assertion">
          <input type="hidden" name="RelayState" value="xyz"></form></body></html>`);
      }
      return redirect(`/idp/my.policy`, { "Set-Cookie": `LastMRH_Session=1; Path=/` });
    }
    if (url.pathname === "/idp/my.policy" && req.method === "GET") return send(200, loginForm());
    if (url.pathname === "/idp/my.policy" && req.method === "POST") {
      const body = await readBody(req);
      passwordAttempts.push(body.get("password") ?? "");
      if (body.get("username") !== VALID_USER.username || body.get("password") !== VALID_USER.password) {
        // The real gateway answers a wrong password with a dead-end page (HTTP 200, no form).
        return send(200, options.wrongPasswordShowsForm ? loginForm("Invalid username or password") : DENIED_PAGE);
      }
      if (options.requireMfa) {
        return send(200, `<html><body><form method="post" action="/idp/mfa"><input type="text" name="otp_code"><input type="submit"></form></body></html>`);
      }
      const sid = crypto.randomUUID();
      idpSessions.add(sid);
      return redirect(`/idp/sso`, { "Set-Cookie": `MRHSession=${sid}; Path=/` });
    }

    // ---------- Syllabus generator (behind the same login) ----------
    if (url.pathname === "/myruni/syllabigenerator/pdf/renderdocument") {
      if (!(jar.MRHSession && idpSessions.has(jar.MRHSession))) return redirect("/idp/my.policy");
      const id = url.searchParams.get("SectionIDC");
      return send(200, minimalPdf(`Algorithms syllabus ${id} Final grade 0.65 E plus 0.15 max M E`), { "Content-Type": "application/pdf" });
    }

    // ---------- Panopto (auto-auth off Moodle, JSON data API, SRT transcripts) ----------
    // Panopto signs in via the My RUNI gateway (SAML, provider "IDCPROD"). Without a gateway
    // session the gateway shows a dead-end "access not found" page (seen live).
    if (url.pathname === "/Panopto/Pages/Auth/Login.aspx" && req.method === "GET") {
      // Moodle provider: Panopto asks Moodle (block_panopto SSO), which answers for its logged-in user.
      if (/^MoodleProd\d{4}$/.test(url.searchParams.get("instance") ?? "")) {
        if (url.searchParams.get("authCode") === "moodle-ok") {
          const sid = crypto.randomUUID();
          panoptoSessions.add(sid);
          return send(200, `<html><body><form method="post" action="Login.aspx"><input type="hidden" name="__VIEWSTATE" value="vs">
            <p>Provider: MoodleProd2027</p><a href="javascript:__doPostBack('ctl00$PageContentPlaceholder$loginControl$Logout','')">Sign out</a></form></body></html>`,
            { "Set-Cookie": `.ASPXAUTH=${sid}; Path=/Panopto` });
        }
        if (url.searchParams.get("AllowBounce") !== "true") return send(200, `<html><body><form method="post" action="./Login.aspx"><input type="hidden" name="__VIEWSTATE" value="vs"></form></body></html>`);
        return redirect(`/moodle/blocks/panopto/SSO.php?serverName=panopto`);
      }
      if (url.searchParams.get("instance") !== "IDCPROD") return redirect("/gw/F5Networks-SSO-Req");
      // Live: without AllowBounce, Panopto answers 200 with an ASP.NET page whose script bounces
      // the browser on; with it, a plain redirect to the gateway.
      if (url.searchParams.get("AllowBounce") !== "true") {
        return send(200, `<html><body><form method="post" action="./Login.aspx?instance=IDCPROD" id="rootForm">
          <input type="hidden" name="__EVENTTARGET" value=""><input type="hidden" name="__VIEWSTATE" value="vs">
          <input type="hidden" name="ctl00$ScriptManagerControl" value=""></form>
          <script>var bounceUrl = '/Panopto/Pages/Auth/Login.aspx?instance=IDCPROD&AllowBounce=true'; if (cookiesOk) window.location.href = bounceUrl;</script></body></html>`);
      }
      return redirect("/gw/F5Networks-SSO-Req?app=panopto");
    }
    if (url.pathname === "/gw/F5Networks-SSO-Req") {
      const bound = gateway.get(jar.GW ?? "");
      if (url.searchParams.get("app") === "panopto" && !bound) return redirect("/gw/my.policy?res=panopto");
      if (url.searchParams.get("app") !== "panopto") return send(404, ACCESS_NOT_FOUND);
      // Seen live 2026-10-19: a session that STARTED at Panopto's SAML request signs in fine but is
      // then refused ("BIG-IP ACL denied"); a session started at the Student Info Station (yedion)
      // may go on to Panopto (seen in a browser 2026-10-16).
      // Seen live 2026-10-19: a student signs in fine but is then refused ("BIG-IP ACL denied").
      return send(200, `<html><head><title>BIG-IP ACL denied page</title></head><body>Access denied</body></html>`);
      return send(200, `<html><body onload="document.forms[0].submit()">
        <form method="post" action="${base}/Panopto/Pages/Auth/Login.aspx"><input type="hidden" name="SAMLResponse" value="panopto-ok"><input type="hidden" name="RelayState" value="r"></form></body></html>`);
    }
    if (url.pathname === "/Panopto/Pages/Auth/Login.aspx" && req.method === "POST") {
      const body = await readBody(req);
      if (body.get("SAMLResponse") !== "panopto-ok") return send(400, "bad");
      const sid = crypto.randomUUID();
      panoptoSessions.add(sid);
      // Live behaviour: Panopto stays on Login.aspx and shows the signed-in user, inside an
      // ASP.NET form with only hidden fields (which must NOT be treated as an auto-post step).
      return send(200, `<html><body><form method="post" action="Login.aspx"><input type="hidden" name="__VIEWSTATE" value="vs">
        <p>Provider: unified</p><a href="javascript:__doPostBack('ctl00$PageContentPlaceholder$loginControl$Logout','')">Sign out</a></form></body></html>`,
        { "Set-Cookie": `.ASPXAUTH=${sid}; Path=/Panopto` });
    }
    if (url.pathname === "/moodle/blocks/panopto/SSO.php") {
      if (!moodleLoggedIn) return redirect("/moodle/login/index.php");
      return redirect(`${base}/Panopto/Pages/Auth/Login.aspx?instance=MoodleProd2027&authCode=moodle-ok`);
    }
    if (url.pathname === "/Panopto/Pages/Home.aspx") return send(200, "<html><body>Panopto home</body></html>");
    if (url.pathname === "/Panopto/Services/Data.svc/GetSessions" && req.method === "POST") {
      // Signed out, Panopto doesn't error: it just finds nothing (seen live).
      if (!panoptoSessions.has(jar[".ASPXAUTH"] ?? "")) {
        return send(200, JSON.stringify({ d: { Results: [], TotalNumber: 0 } }), { "Content-Type": "application/json" });
      }
      const body = JSON.parse((await readRaw(req)) || "{}");
      const q = body?.queryParameters?.query ?? "";
      return send(
        200,
        JSON.stringify({
          d: {
            Results: [
              {
                SessionName: `תרגול 5 ${q}`,
                FolderName: "Introduction to Probability-109-2027/1",
                Duration: 3900,
                StartTime: "/Date(1760000000000)/",
                HasCaptions: true,
                ViewerUrl: `${base}/Panopto/Pages/Viewer.aspx?id=rec-5`,
                DeliveryID: "rec-5",
              },
            ],
            TotalNumber: 1,
          },
        }),
        { "Content-Type": "application/json" },
      );
    }
    if (url.pathname === "/Panopto/Pages/Transcription/GenerateSRT.ashx") {
      return send(
        200,
        "1\n00:03:12,000 --> 00:03:15,000\nנדבר על התפלגות הפעמון\n\n2\n00:03:15,000 --> 00:03:18,000\nזאת ההתפלגות הנורמלית\n",
        { "Content-Type": "text/plain" },
      );
    }

    // ---------- Student Info Station (Michlol) ----------
    // Its own gateway login, separate from Moodle's (seen live: yedion -> my.runi.ac.il/my.policy).
    if (url.pathname === "/yedion/login.aspx") {
      const bound = gateway.get(jar.GW ?? "");
      if (!bound) return redirect("/gw/my.policy?res=yedion");
      if (bound !== "yedion") return redirect("/gw/F5Networks-SSO-Req?app=yedion"); // → access not found
      const sid = crypto.randomUUID();
      yedionSessions.add(sid);
      return redirect("/yedion/fireflyweb.aspx", { "Set-Cookie": `YSession=${sid}; Path=/yedion` });
    }
    if (url.pathname === "/gw/my.policy" && req.method === "GET") {
      return send(200, loginForm().replace("/idp/my.policy", `/gw/my.policy?res=${url.searchParams.get("res") ?? "yedion"}`));
    }
    if (url.pathname === "/gw/my.policy" && req.method === "POST") {
      const body = await readBody(req);
      passwordAttempts.push(body.get("password") ?? "");
      if (body.get("username") !== VALID_USER.username || body.get("password") !== VALID_USER.password) return send(200, DENIED_PAGE);
      const sid = crypto.randomUUID();
      const res = url.searchParams.get("res") === "panopto" ? "panopto" : "yedion";
      gateway.set(sid, res);
      const next = res === "panopto" ? "/gw/F5Networks-SSO-Req?app=panopto" : "/yedion/login.aspx?Type=S";
      return redirect(next, { "Set-Cookie": `GW=${sid}; Path=/` });
    }
    if (url.pathname === "/yedion/fireflyweb.aspx" && req.method === "GET") {
      return send(200, `<html><body><a href="fireflyweb.aspx?prgname=Menu">menu</a></body></html>`);
    }
    if (url.pathname === "/yedion/fireflyweb.aspx" && req.method === "POST") {
      if (!yedionSessions.has(jar.YSession ?? "")) return send(200, LOGGED_OUT_PAGE);
      const body = await readBody(req);
      const prg = body.get("PRGNAME");
      const yearOptions = `<option value="">בחירת שנה</option><option value="-1">כל השנים</option><option value="2027" selected>2027 - תשפ"ז</option><option value="2026">2026 - תשפ"ו</option>`;
      const semOptions = `<option value="בחירת שנה">בחירת שנה</option><option value="0">שנתי</option><option value="1" selected>1</option><option value="2">2</option>`;
      if (prg === "MenuCall") {
        const menu = body.get("ARGUMENTS")?.match(/-N(\d+),-A/)?.[1];
        const queryCode = menu === "6" ? "" : `<input type="hidden" name="QueryCode" value="${menu}">`;
        const terms = menu === "6" ? `<select name="Terms"><option value="0" selected>כל המועדים</option></select>` : "";
        return send(200, `<html><body><form name="form" method="post" action="fireflyweb.aspx">
          <input type="hidden" name="PRGNAME" value=""><input type="hidden" name="ARGUMENTS" value="">
          <input type="hidden" name="TZ" value="123456789"><input type="hidden" name="Token" value="tok-${menu}">${queryCode}
          <select name="R1C1">${yearOptions}</select><select name="R1C2">${semOptions}</select>${terms}
        </form></body></html>`);
      }
      const grid = (rows: string[][]) =>
        `<main><div class="card MasterTable"><div class="Table">${rows
          .map((r) => `<div class="row">${r.map((c) => `<div class="col">${c}</div>`).join("")}</div>`)
          .join("")}</div></div></main>`;
      if (prg === "StudentQueryExecution" && body.get("ARGUMENTS") === "TZ,Token,QueryCode,R1C1,R1C2") {
        const code = body.get("QueryCode");
        if (body.get("Token") !== `tok-${code}`) return send(200, "<html><body>bad token</body></html>");
        if (code === "13") {
          const card = (course: string, part: string, sitting: string, grade: string) =>
            `<div class="Box_ph"><div class="InRange">${course}</div><div class="InRange">נקודות זכות  / שעות סמסטריאליות  / מועד ${sitting}</div><div class="InRange">${part}</div><div>B.Sc</div><strong>ציון: ${grade}</strong></div>`;
          const all = body.get("R1C1") === "-1";
          return send(200, `<html><body>${card("77 אלגוריתמים", "שיעור", "1", "95")}${card("77 אלגוריתמים", "תרגול", "1", "88")}${
            all ? card("52 חשבון אינפיניטיסמלי א'", "שיעור", "2", "81") : ""
          }${card("109 מבוא להסתברות", "שיעור", "1", "טרם")}${card("5400 יזמות פינטק", "- סדנה", "1", "טרם")}</body></html>`);
        }
        if (code === "16") {
          if (body.get("R1C2") === "0") return send(200, `<html><body><main>לא מוגדרת מערכת שעות לתחום שנבחר</main></body></html>`);
          return send(200, `<html><body><main><p>מ.ז 123456789</p></main>${grid([
            ["", "יום ראשון", "יום שני", "יום שלישי"],
            ["08:45", "", "109-מבוא להסתברות שיעור מר נוביק עמית אולם H1 08:45-11:15", ""],
            ["09:45", "", "המשך מבוא להסתברות", "3030-תכנות מתקדם תרגול מר קריב אביעד SL302 09:45-11:15"],
            ["14:30", "", "669-הרצאת אורח-מדעי המחשב שיעור\n\nC.L05 אודיטוריום צ'ייס 14:30-15:30", ""],
          ])}</body></html>`);
        }
      }
      if (prg === "HADPASAT_TOCHNIT_BEHINOT" && body.get("ARGUMENTS") === "TZ,Token,R1C1,R1C2,R1C3") {
        if (body.get("Token") !== "tok-6") return send(200, "<html><body>bad token</body></html>");
        return send(200, `<html><body>${grid([
          ["מועד", "קוד קורס", "שם קורס", "בית ספר", "תאריך", "שעת התחלה", "חדר בחינה"],
          ["1", "77", "אלגוריתמים", "בית ספ", "25/01/2027", "09:45", "טרם נקבע"],
          ["2", "77", "אלגוריתמים", "בית ספ", "20/02/2027", "09:45", "טרם נקבע"],
        ])}</body></html>`);
      }
      return send(200, "<html><body>unknown query</body></html>");
    }

    // A login that accepts the right password but then dead-ends on an unrelated error page
    // (like My RUNI's "access not found"). Must NOT be read as a wrong password.
    if (url.pathname === "/trap/start") return send(200, loginForm().replace("/idp/my.policy", "/trap/login"));
    if (url.pathname === "/trap2/start") return send(200, loginForm().replace("/idp/my.policy", "/trap2/login"));
    if (url.pathname === "/trap2/login" && req.method === "POST") return send(200, loginForm()); // login page again, no error text
    if (url.pathname === "/trap/login" && req.method === "POST") {
      return send(200, `<html><head><title>IDC-Herzliya - access not found</title></head><body><p>לצערנו משהו השתבש...</p><a href="/">לחצו כאן להתחברות מחדש</a></body></html>`);
    }

    // ---------- Piazza (separate account; form login + JSON-RPC with a CSRF-Token header) ----------
    if (url.pathname === "/account/login") {
      return send(200, `<html><body><form id="login-form" method="post" action="${base}/class">
        <input type="hidden" name="from" value="/signup"><input type="text" name="email"><input type="password" name="password">
        <input type="checkbox" name="remember"><input type="submit"><input type="hidden" name="csrf_token" value="pre-login"></form></body></html>`);
    }
    if (url.pathname === "/class" && req.method === "POST") {
      const body = await readBody(req);
      if (body.get("csrf_token") !== "pre-login") return send(403, "csrf");
      if (body.get("email") !== VALID_PIAZZA.email || body.get("password") !== VALID_PIAZZA.password) {
        return send(200, `<html><head><script>var ERROR_MSG = "Email or password is incorrect.";</script></head><body>
          <form id="login-form" method="post" action="${base}/class"><input type="text" name="email"><input type="password" name="password"></form></body></html>`);
      }
      const sid = crypto.randomUUID();
      piazzaSessions.set(sid, "csrf-" + sid.slice(0, 8));
      return send(200, "<html><body>Piazza classes</body></html>", { "Set-Cookie": `session_id=${sid}; Path=/` });
    }
    if (url.pathname === "/main/csrf_token") {
      const csrf = piazzaSessions.get(jar.session_id ?? "") ?? "pre-login";
      return send(200, `CSRF_TOKEN = "${csrf}";`, { "Content-Type": "application/javascript" });
    }
    if (url.pathname === "/logic/api" && req.method === "POST") {
      const body = JSON.parse((await readRaw(req)) || "{}");
      const csrf = piazzaSessions.get(jar.session_id ?? "");
      const json = (data: unknown) => send(200, JSON.stringify(data), { "Content-Type": "application/json" });
      if (!csrf || req.headers["csrf-token"] !== csrf) return json({ result: null, error: "Not logged in" });
      if (url.searchParams.get("method") !== body.method) return json({ result: null, error: "method mismatch" });
      if (body.method === "user.status")
        return json({ result: { networks: [{ id: "net1", name: "Advanced Programming", course_number: "3030", term: "Fall 2026" }] }, error: null });
      if (body.method === "network.search")
        return json({ result: [{ id: "p1", nr: 12, subject: "HW2 <b>deadline</b>", type: "question" }], error: null });
      if (body.method === "content.get")
        return json({ result: { id: "p1", nr: 12, type: "question", history: [{ subject: "HW2 deadline", content: "<p>Is it Thursday?</p>" }] }, error: null });
      return json({ result: null, error: `unknown ${body.method}` });
    }

    send(404, "not found");
  });

  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({ server, base: `http://127.0.0.1:${actualPort}` });
    }),
  );
}
