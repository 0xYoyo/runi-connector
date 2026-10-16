// A fake Reichman: Moodle (SAML-protected, with a mobile launch.php and REST API),
// an F5-style login page acting as the identity provider, and the syllabus generator.
// Everything lives on one local port under different path prefixes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const VALID_USER = { username: "student1", password: "correct-horse" };
export const MOODLE_TOKEN = "0123456789abcdef0123456789abcdef";

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

export function startMockReichman(port = 0, options: { requireMfa?: boolean } = {}): Promise<{ server: Server; base: string }> {
  const sessions = new Set<string>(); // moodle sessions
  const idpSessions = new Set<string>();

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
      if (body.get("username") !== VALID_USER.username || body.get("password") !== VALID_USER.password) {
        return send(200, loginForm("Invalid username or password"));
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
    if (url.pathname === "/Panopto/Pages/Auth/Login.aspx") {
      const sid = crypto.randomUUID();
      sessions.add(sid);
      return send(200, "<html><body>ok</body></html>", { "Set-Cookie": `.ASPXAUTH=${sid}; Path=/` });
    }
    if (url.pathname === "/Panopto/Services/Data.svc/GetSessions" && req.method === "POST") {
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
    if (url.pathname === "/yedion/login.aspx") {
      if (!(jar.MRHSession && idpSessions.has(jar.MRHSession))) return redirect("/idp/my.policy");
      const sid = crypto.randomUUID();
      sessions.add(sid);
      return redirect("/yedion/fireflyweb.aspx", { "Set-Cookie": `YSession=${sid}; Path=/yedion` });
    }
    if (url.pathname === "/yedion/fireflyweb.aspx" && req.method === "POST") {
      const body = await readBody(req);
      const prg = body.get("PRGNAME");
      if (prg === "MenuCall") {
        // grades request screen
        return send(
          200,
          `<html><body><form name="form" method="post" action="fireflyweb.aspx">
            <input type="hidden" name="TZ" value="123">
            <input type="hidden" name="Token" value="tok-abc">
            <input type="hidden" name="QueryCode" value="13">
            <select name="R1C1"><option value="-1">all</option></select>
            <select name="R1C2"><option value="0">year</option></select>
          </form></body></html>`,
        );
      }
      if (prg === "StudentQueryExecution") {
        if (body.get("Token") !== "tok-abc") return send(200, "<html><body>bad token</body></html>");
        return send(
          200,
          `<html><body>
            <div class="Box_ph"><h2 class="pagetitle">77 אלגוריתמים</h2><div class="InRange">5</div><div class="InRange">שיעור</div><div><strong>ציון: 95</strong></div></div>
            <div class="Box_ph"><h2 class="pagetitle">109 מבוא להסתברות</h2><div class="InRange">4</div><div class="InRange">שיעור</div><div><strong>ציון: טרם</strong></div></div>
          </body></html>`,
        );
      }
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
