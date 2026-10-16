import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isPdf, isTextLike, pdfToText, truncate } from "./documents";
import { matchCourse, MoodleClient, MoodleSessionExpired, type MoodleCourse } from "./moodle";
import { cachedSyllabus, sectionIdsForCourse } from "./syllabi";

export interface UserProps extends Record<string, unknown> {
  moodleToken: string;
  moodleBase: string;
  userId: number;
  fullName: string;
}

interface ModuleContent {
  type: string;
  filename: string;
  fileurl: string;
  filesize: number;
  mimetype?: string;
  timemodified?: number;
}
interface CourseModule {
  id: number;
  name: string;
  modname: string;
  url?: string;
  description?: string;
  contents?: ModuleContent[];
}
interface CourseSection {
  id: number;
  name: string;
  summary: string;
  modules: CourseModule[];
}

const INSTRUCTIONS = `Tools for a Reichman University student's own courses (Moodle and syllabi).
- Course arguments accept a course name (Hebrew or English), a course number like "77", or a Moodle id.
- Syllabi include grading formulas, AI policies, attendance rules and reading lists.
- AI policies differ per course (some ban AI on graded work entirely). Before helping with an assignment, check that course's syllabus AI policy and respect it; explaining material and exam prep are always fine.
- This connector is unofficial and read-only.`;

function htmlToText(html = ""): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function formatDate(unixSeconds?: number): string {
  if (!unixSeconds) return "no date";
  return new Date(unixSeconds * 1000).toLocaleString("en-GB", {
    timeZone: "Asia/Jerusalem",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function failure(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const readOnly = { readOnlyHint: true, openWorldHint: false };

// Minimal shapes the extra services expose, so tools.ts doesn't import their modules directly.
export interface PanoptoLike {
  search(query: string, maxResults?: number): Promise<
    Array<{ name: string; folder: string; durationMin: number; startedAt: string | null; hasCaptions: boolean; viewerUrl: string; deliveryId: string }>
  >;
  transcript(deliveryId: string): Promise<string | null>;
  viewerLink(deliveryId: string, atSeconds?: number): string;
}
export interface MichlolLike {
  grades(year?: number | "all", semester?: number): Promise<Array<{ course: string; component: string; grade: string; credits: string }>>;
}
export interface PiazzaLike {
  configured: boolean;
  classes(): Promise<Array<{ id: string; name: string; num: string; term: string }>>;
  findClass(query: string): Promise<{ id: string; name: string; num: string } | undefined>;
  search(classId: string, query: string): Promise<Array<{ number: number; subject: string; type: string }>>;
  post(classId: string, postNumber: number): Promise<{ number: number; subject: string; content: string; type: string }>;
}

export interface BuildOptions {
  /** Called when Moodle rejects the token. Return fresh props to retry the tool once. */
  onSessionExpired?: () => Promise<UserProps>;
  /** Downloads and caches one course's syllabus on demand (local versions only). */
  fetchSyllabus?: (course: MoodleCourse) => Promise<void>;
  /** Lecture recordings + transcripts (local versions only). */
  panopto?: PanoptoLike;
  /** Official grades from the Student Info Station (local versions only). */
  michlol?: MichlolLike;
  /** Piazza Q&A (local versions only; `configured` is false until the user adds Piazza login). */
  piazza?: PiazzaLike;
  /** Caption text compactor, injected so tools.ts stays free of the panopto module. */
  srtToText?: (srt: string) => string;
}

function srtPlain(result: string): string {
  return result;
}

export function buildServer(initialProps: UserProps, kv: KVNamespace, options: BuildOptions = {}): McpServer {
  const server = new McpServer(
    { name: "reichman-runi", version: "0.2.0" },
    { instructions: INSTRUCTIONS },
  );
  let props = initialProps;
  let moodle = new MoodleClient(props.moodleBase, props.moodleToken);

  let coursesPromise: Promise<MoodleCourse[]> | undefined;
  const courses = () => (coursesPromise ??= moodle.courses(props.userId));

  // One sign-in at a time, even if several tools hit an expired token together.
  let refreshing: Promise<void> | undefined;
  async function refreshSession() {
    refreshing ??= (async () => {
      props = await options.onSessionExpired!();
      moodle = new MoodleClient(props.moodleBase, props.moodleToken);
      coursesPromise = undefined;
    })().finally(() => (refreshing = undefined));
    return refreshing;
  }

  // Wraps a tool handler so expired sessions and other errors come back as readable messages.
  // With onSessionExpired, an expired token triggers one automatic sign-in and retry.
  function safe<A>(handler: (args: A) => Promise<ReturnType<typeof text>>) {
    return async (args: A) => {
      try {
        return await handler(args);
      } catch (error) {
        if (error instanceof MoodleSessionExpired) {
          if (!options.onSessionExpired) return failure(error.message);
          try {
            await refreshSession();
            return await handler(args);
          } catch (retryError) {
            return failure(`Couldn't sign in again automatically: ${(retryError as Error).message}`);
          }
        }
        return failure(`Error: ${(error as Error).message}`);
      }
    };
  }

  async function resolveCourse(query: string): Promise<MoodleCourse> {
    const all = await courses();
    const course = matchCourse(all, query);
    if (!course) {
      throw new Error(
        `No course matches "${query}". Your courses: ${all.map((c) => `${c.fullname} (${c.courseNumber ?? c.id})`).join(", ")}`,
      );
    }
    return course;
  }

  const contents = (courseId: number) =>
    moodle.call<CourseSection[]>("core_course_get_contents", { courseid: courseId });

  server.registerTool(
    "list_courses",
    {
      title: "List my courses",
      description: "Lists the student's current Moodle courses with their course numbers and Moodle ids.",
      inputSchema: {},
      annotations: readOnly,
    },
    safe(async () => {
      const all = await courses();
      const lines = all.map(
        (c) => `- ${c.fullname} | course no. ${c.courseNumber ?? "?"} | moodle id ${c.id}`,
      );
      return text(`${props.fullName}'s courses (${all.length}):\n${lines.join("\n")}`);
    }),
  );

  server.registerTool(
    "get_syllabus",
    {
      title: "Get a course syllabus",
      description:
        "Returns the full text of a course's official syllabus: topics, grading formula, AI policy, attendance rules, prerequisites, reading list.",
      inputSchema: { course: z.string().describe('Course name, number (e.g. "77") or Moodle id') },
      annotations: readOnly,
    },
    safe(async ({ course }: { course: string }) => {
      const found = await resolveCourse(course);
      let sectionIds = await sectionIdsForCourse(kv, found.id);
      const haveText = async () => {
        for (const id of sectionIds) if (await cachedSyllabus(kv, id)) return true;
        return false;
      };
      // Not cached yet: fetch it now if this host can (the desktop extension can; the hosted one can't).
      if ((sectionIds.length === 0 || !(await haveText())) && options.fetchSyllabus) {
        await options.fetchSyllabus(found);
        sectionIds = await sectionIdsForCourse(kv, found.id);
      }
      if (sectionIds.length === 0) {
        return text(`${found.fullname} has no syllabus linked on its Moodle page.`);
      }
      // Different section ids are different lecture/recitation groups of the same course;
      // their syllabi are normally identical, so return the first one we have.
      for (const sectionId of sectionIds) {
        const syllabus = await cachedSyllabus(kv, sectionId);
        if (syllabus) {
          const note =
            sectionIds.length > 1 ? `\n(This course has ${sectionIds.length} groups; showing group syllabus ${sectionId}.)` : "";
          return text(`Syllabus for ${found.fullname}${note}\n\n${truncate(syllabus.text)}`);
        }
      }
      return text(`The syllabus for ${found.fullname} is linked on Moodle but couldn't be downloaded right now. Try again in a minute.`);
    }),
  );

  server.registerTool(
    "get_course_contents",
    {
      title: "Get course contents",
      description:
        "Lists a course's Moodle sections with their activities and files (lecture slides, recitations, homework). Use read_course_file to open a file.",
      inputSchema: { course: z.string().describe("Course name, number or Moodle id") },
      annotations: readOnly,
    },
    safe(async ({ course }: { course: string }) => {
      const found = await resolveCourse(course);
      const sections = await contents(found.id);
      const out: string[] = [`${found.fullname}`];
      for (const section of sections) {
        out.push(`\n## ${section.name || "(untitled section)"}`);
        const summary = htmlToText(section.summary);
        if (summary) out.push(summary.slice(0, 400));
        if (section.modules.length === 0 && !summary) out.push("(nothing published here yet)");
        for (const mod of section.modules) {
          out.push(`- [${mod.modname}] ${mod.name}${mod.url ? ` (${mod.url})` : ""}`);
          for (const file of mod.contents ?? []) {
            if (file.type !== "file") continue;
            out.push(`    • ${file.filename} — ${Math.round(file.filesize / 1024)} KB — ${file.fileurl}`);
          }
        }
      }
      return text(truncate(out.join("\n")));
    }),
  );

  server.registerTool(
    "read_course_file",
    {
      title: "Read a course file",
      description:
        "Downloads a file from a course and returns its text (PDFs and text/code files). Pass a file URL from get_course_contents, or a course plus part of the file name.",
      inputSchema: {
        file: z.string().describe("A file URL from get_course_contents, or part of the file name"),
        course: z.string().optional().describe("Course name/number; needed when `file` is a name, not a URL"),
      },
      annotations: readOnly,
    },
    safe(async ({ file, course }: { file: string; course?: string }) => {
      let fileUrl = file;
      let filename = file;
      if (!/^https?:\/\//.test(file)) {
        if (!course) return failure("Give the course too when `file` is a name rather than a URL.");
        const found = await resolveCourse(course);
        const all = (await contents(found.id)).flatMap((s) => s.modules.flatMap((m) => m.contents ?? []));
        const needle = file.toLowerCase();
        const match = all.find((c) => c.type === "file" && c.filename.toLowerCase().includes(needle));
        if (!match) return failure(`No file matching "${file}" in ${found.fullname}.`);
        fileUrl = match.fileurl;
        filename = match.filename;
      } else {
        filename = decodeURIComponent(new URL(file).pathname.split("/").pop() ?? file);
      }

      const { bytes, contentType } = await moodle.downloadFile(fileUrl);
      if (isPdf(bytes, contentType)) {
        const { text: body, pages } = await pdfToText(bytes);
        return text(`${filename} (${pages} pages)\n\n${truncate(body)}`);
      }
      if (isTextLike(contentType, filename)) {
        return text(`${filename}\n\n${truncate(new TextDecoder().decode(bytes))}`);
      }
      return text(
        `${filename} is a ${contentType} file (${Math.round(bytes.byteLength / 1024)} KB). This connector can only read PDFs and text files; open it from Moodle: ${fileUrl}`,
      );
    }),
  );

  server.registerTool(
    "get_upcoming_deadlines",
    {
      title: "Upcoming deadlines",
      description: "Lists upcoming assignment due dates, quizzes and other Moodle events across all courses.",
      inputSchema: { days: z.number().int().min(1).max(120).default(21).describe("How many days ahead to look") },
      annotations: readOnly,
    },
    safe(async ({ days }: { days: number }) => {
      const now = Math.floor(Date.now() / 1000);
      const result = await moodle.call<{
        events: Array<{ name: string; timesort: number; url?: string; modulename?: string; course?: { fullname: string } }>;
      }>("core_calendar_get_action_events_by_timesort", {
        timesortfrom: now,
        timesortto: now + days * 86400,
        limitnum: 50,
      });
      if (result.events.length === 0) return text(`Nothing due in the next ${days} days.`);
      const lines = result.events.map(
        (e) => `- ${formatDate(e.timesort)} — ${e.course?.fullname ?? ""}: ${e.name}${e.url ? ` (${e.url})` : ""}`,
      );
      return text(`Due in the next ${days} days:\n${lines.join("\n")}`);
    }),
  );

  server.registerTool(
    "get_assignments",
    {
      title: "Course assignments",
      description: "Lists a course's assignments with due dates and instructions.",
      inputSchema: { course: z.string().describe("Course name, number or Moodle id") },
      annotations: readOnly,
    },
    safe(async ({ course }: { course: string }) => {
      const found = await resolveCourse(course);
      const result = await moodle.call<{
        courses: Array<{ assignments: Array<{ name: string; duedate: number; intro: string; cmid: number }> }>;
      }>("mod_assign_get_assignments", { courseids: [found.id] });
      const assignments = result.courses[0]?.assignments ?? [];
      if (assignments.length === 0) return text(`${found.fullname} has no Moodle assignments yet.`);
      const lines = assignments
        .sort((a, b) => a.duedate - b.duedate)
        .map((a) => `## ${a.name}\nDue: ${formatDate(a.duedate)}\n${htmlToText(a.intro).slice(0, 1500)}`);
      return text(`${found.fullname} — assignments\n\n${lines.join("\n\n")}`);
    }),
  );

  server.registerTool(
    "get_my_grades",
    {
      title: "My grades in a course",
      description: "Shows the student's grade items in a course's Moodle gradebook (homework, quizzes, etc.).",
      inputSchema: { course: z.string().describe("Course name, number or Moodle id") },
      annotations: readOnly,
    },
    safe(async ({ course }: { course: string }) => {
      const found = await resolveCourse(course);
      const result = await moodle.call<{
        usergrades: Array<{
          gradeitems: Array<{
            itemname: string | null;
            itemtype: string;
            gradeformatted: string;
            rangeformatted: string;
            percentageformatted: string;
            feedback: string;
          }>;
        }>;
      }>("gradereport_user_get_grade_items", { courseid: found.id, userid: props.userId });
      const items = result.usergrades[0]?.gradeitems ?? [];
      const graded = items.filter((i) => i.gradeformatted && i.gradeformatted !== "-");
      if (graded.length === 0) return text(`No grades published yet in ${found.fullname}.`);
      const lines = graded.map((i) => {
        const name = i.itemtype === "course" ? "Course total" : i.itemname ?? "(item)";
        const feedback = htmlToText(i.feedback);
        return `- ${name}: ${i.gradeformatted} (range ${i.rangeformatted}, ${i.percentageformatted})${feedback ? ` — feedback: ${feedback.slice(0, 300)}` : ""}`;
      });
      return text(`${found.fullname} — grades\n${lines.join("\n")}`);
    }),
  );

  server.registerTool(
    "get_announcements",
    {
      title: "Course announcements",
      description: "Returns the latest posts in a course's announcements (news) forum.",
      inputSchema: {
        course: z.string().describe("Course name, number or Moodle id"),
        limit: z.number().int().min(1).max(20).default(5),
      },
      annotations: readOnly,
    },
    safe(async ({ course, limit }: { course: string; limit: number }) => {
      const found = await resolveCourse(course);
      const forums = await moodle.call<Array<{ id: number; type: string; name: string }>>(
        "mod_forum_get_forums_by_courses",
        { courseids: [found.id] },
      );
      const news = forums.find((f) => f.type === "news") ?? forums[0];
      if (!news) return text(`${found.fullname} has no announcements forum.`);
      const result = await moodle.call<{
        discussions: Array<{ subject: string; message: string; created: number; userfullname: string }>;
      }>("mod_forum_get_forum_discussions", { forumid: news.id, page: 0, perpage: limit });
      if (result.discussions.length === 0) return text(`No announcements yet in ${found.fullname}.`);
      const posts = result.discussions.map(
        (d) => `## ${d.subject}\n${formatDate(d.created)} — ${d.userfullname}\n${htmlToText(d.message).slice(0, 2000)}`,
      );
      return text(`${found.fullname} — ${news.name}\n\n${posts.join("\n\n")}`);
    }),
  );

  server.registerTool(
    "search_course_materials",
    {
      title: "Search course materials",
      description:
        "Searches activity and file names across all courses (e.g. 'recitation 3', 'dijkstra', 'HW2'). Returns matches with links.",
      inputSchema: { query: z.string().min(2) },
      annotations: readOnly,
    },
    safe(async ({ query }: { query: string }) => {
      const needle = query.toLowerCase();
      const hits: string[] = [];
      for (const course of await courses()) {
        let sections: CourseSection[];
        try {
          sections = await contents(course.id);
        } catch (error) {
          if (error instanceof MoodleSessionExpired) throw error;
          continue;
        }
        for (const section of sections) {
          for (const mod of section.modules) {
            if (mod.name.toLowerCase().includes(needle)) {
              hits.push(`- ${course.fullname} › ${section.name} › ${mod.name}${mod.url ? ` (${mod.url})` : ""}`);
            }
            for (const file of mod.contents ?? []) {
              if (file.type === "file" && file.filename.toLowerCase().includes(needle)) {
                hits.push(`- ${course.fullname} › ${mod.name} › ${file.filename} (${file.fileurl})`);
              }
            }
          }
        }
      }
      if (hits.length === 0) return text(`Nothing named like "${query}" in your courses.`);
      return text(truncate(`Matches for "${query}":\n${hits.slice(0, 80).join("\n")}`));
    }),
  );

  // ---------- Panopto (lecture recordings + transcripts) ----------
  if (options.panopto) {
    const panopto = options.panopto;
    const toText = options.srtToText ?? srtPlain;

    server.registerTool(
      "search_lectures",
      {
        title: "Search lecture recordings",
        description:
          "Searches Panopto recordings (lectures and recitations) by title, course or keyword. Returns titles, folders, length and a link. Use get_lecture_transcript to read what was said.",
        inputSchema: { query: z.string().min(2).describe("e.g. 'probability recitation 5', a lecturer, or a topic") },
        annotations: readOnly,
      },
      safe(async ({ query }: { query: string }) => {
        const results = await panopto.search(query);
        if (results.length === 0) return text(`No recordings match "${query}".`);
        const lines = results.map((r) => {
          const when = r.startedAt ? new Date(r.startedAt).toLocaleDateString("en-GB", { timeZone: "Asia/Jerusalem" }) : "";
          return `- ${r.name} — ${r.folder} — ${r.durationMin} min${when ? ` — ${when}` : ""}${r.hasCaptions ? "" : " (no transcript)"}\n  id: ${r.deliveryId} — ${r.viewerUrl}`;
        });
        return text(truncate(`Recordings for "${query}":\n${lines.join("\n")}`));
      }),
    );

    server.registerTool(
      "get_lecture_transcript",
      {
        title: "Read a lecture transcript",
        description:
          "Returns the transcript of a Panopto recording (with timestamps), so you can answer questions about what was said or find a link to the right moment. Pass the recording id from search_lectures.",
        inputSchema: { recording_id: z.string().describe("The recording id from search_lectures") },
        annotations: readOnly,
      },
      safe(async ({ recording_id }: { recording_id: string }) => {
        const srt = await panopto.transcript(recording_id);
        if (!srt) return text("This recording has no transcript available.");
        return text(`${panopto.viewerLink(recording_id)}\n\n${truncate(toText(srt))}`);
      }),
    );
  }

  // ---------- Student Info Station: official grades ----------
  if (options.michlol) {
    const michlol = options.michlol;
    server.registerTool(
      "get_official_grades",
      {
        title: "Official grades (Student Info Station)",
        description:
          "Your official grades from the Student Info Station (not the Moodle gradebook): final course grades, including 'not yet' where a grade isn't published.",
        inputSchema: {
          year: z.union([z.number().int(), z.literal("all")]).default("all").describe("Academic year, or 'all'"),
          semester: z.number().int().min(0).max(6).default(0).describe("0 = whole year, 1/2 = semester"),
        },
        annotations: readOnly,
      },
      safe(async ({ year, semester }: { year: number | "all"; semester: number }) => {
        const rows = await michlol.grades(year, semester);
        if (rows.length === 0) return text("No grade rows found for that selection.");
        const lines = rows.map((r) => `- ${r.course}${r.component ? ` (${r.component})` : ""}: ${r.grade || "—"}`);
        return text(truncate(`Official grades:\n${lines.join("\n")}`));
      }),
    );
  }

  // ---------- Piazza ----------
  if (options.piazza) {
    const piazza = options.piazza;
    const needsSetup = () =>
      text(
        "Piazza isn't set up. Piazza uses a separate login, so add your Piazza email and password in the extension's settings (Claude Desktop → Settings → Extensions → Reichman Courses), then try again.",
      );

    server.registerTool(
      "piazza_list_classes",
      {
        title: "List my Piazza classes",
        description: "Lists the Piazza classes you're enrolled in, with their course numbers.",
        inputSchema: {},
        annotations: readOnly,
      },
      safe(async () => {
        if (!piazza.configured) return needsSetup();
        const classes = await piazza.classes();
        if (classes.length === 0) return text("No Piazza classes found on your account.");
        return text(`Your Piazza classes:\n${classes.map((c) => `- ${c.name}${c.num ? ` (${c.num})` : ""} — ${c.term}`).join("\n")}`);
      }),
    );

    server.registerTool(
      "piazza_search",
      {
        title: "Search a Piazza class",
        description:
          "Searches posts in a Piazza class (questions, notes, announcements). Give the course number or name plus what to look for. Use piazza_read_post to open a result.",
        inputSchema: {
          course: z.string().describe("Piazza course number or name"),
          query: z.string().min(2).describe("What to search for"),
        },
        annotations: readOnly,
      },
      safe(async ({ course, query }: { course: string; query: string }) => {
        if (!piazza.configured) return needsSetup();
        const cls = await piazza.findClass(course);
        if (!cls) return text(`No Piazza class matches "${course}".`);
        const posts = await piazza.search(cls.id, query);
        if (posts.length === 0) return text(`Nothing in ${cls.name} matches "${query}".`);
        return text(
          `Posts in ${cls.name} matching "${query}":\n${posts.map((p) => `- @${p.number} [${p.type}] ${p.subject}`).join("\n")}\n\nUse piazza_read_post with the course and a post number.`,
        );
      }),
    );

    server.registerTool(
      "piazza_read_post",
      {
        title: "Read a Piazza post",
        description: "Reads a Piazza post (and its number) in full. Give the course and the @number from piazza_search.",
        inputSchema: {
          course: z.string().describe("Piazza course number or name"),
          post_number: z.number().int().positive().describe("The @number of the post"),
        },
        annotations: readOnly,
      },
      safe(async ({ course, post_number }: { course: string; post_number: number }) => {
        if (!piazza.configured) return needsSetup();
        const cls = await piazza.findClass(course);
        if (!cls) return text(`No Piazza class matches "${course}".`);
        const post = await piazza.post(cls.id, post_number);
        return text(truncate(`@${post.number} [${post.type}] ${post.subject}\n\n${post.content}`));
      }),
    );
  }

  return server;
}
