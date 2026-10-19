// More of Moodle, through the same web-service API the Moodle mobile app uses: forums, assignment
// and quiz feedback, attendance, "what's new", and reading any Moodle page as text. Plus actions
// that change things (submit an assignment, post in a forum), which always go through a preview
// the student has to approve first (see ./actions.ts).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MoodleClient, MoodleCourse } from "./moodle";
import type { PendingActions } from "./actions";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

interface CourseModule {
  id: number;
  name: string;
  modname: string;
  instance?: number;
  url?: string;
  description?: string;
  contents?: Array<{ fileurl?: string }>;
}
interface CourseSection {
  id: number;
  name: string;
  summary?: string;
  modules: CourseModule[];
}

export interface ExtrasContext {
  safe: <A>(handler: (args: A) => Promise<ToolResult>, needsMoodle?: boolean) => (args: A) => Promise<ToolResult>;
  moodle: () => MoodleClient;
  resolveCourse: (query: string) => Promise<MoodleCourse>;
  courses: () => Promise<MoodleCourse[]>;
  contents: (courseId: number) => Promise<CourseSection[]>;
  userId: () => number;
  text: (value: string) => ToolResult;
  failure: (value: string) => ToolResult;
  truncate: (value: string) => string;
  htmlToText: (html?: string) => string;
  formatDate: (unixSeconds?: number) => string;
  /** Reads a Moodle web page with the signed-in Moodle session (local versions only). */
  readMoodlePage?: (url: string) => Promise<string>;
  /** Opens a Moodle external-tool (LTI) activity like clicking it; returns the tool's page (local only). */
  launchLti?: (cmid: number) => Promise<{ url: string; html: string }>;
  /** Meetings listed in a course's Zoom activity (local only). */
  zoomMeetings?: (cmid: number) => Promise<import("./zoom").ZoomMeetings>;
  /** Reads a file from the student's computer, for submissions (local versions only). */
  readLocalFile?: (path: string) => Promise<{ name: string; bytes: Uint8Array }>;
  /** Present only where changing things is allowed (local versions). */
  actions?: PendingActions;
}

// The page's main region only (Moodle's role="main" element, matched to its closing tag), without
// the navigation, accessibility menu and footer around it.
function mainRegion(html: string): string {
  const open = html.match(/<(div|section)\b[^>]*(?:role=["']main["']|id=["']region-main["'])[^>]*>/i);
  if (!open || open.index === undefined) return html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  const tag = open[1].toLowerCase();
  const re = new RegExp(`<${tag}\\b|<\\/${tag}>`, "gi");
  re.lastIndex = open.index + open[0].length;
  let depth = 1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(open.index + open[0].length, m.index);
  }
  return html.slice(open.index + open[0].length);
}

/** The readable text of a Moodle page: its main region, with table rows kept on one line each. */
export function moodlePageText(html: string): string {
  // Moodle puts its accessibility menu inside the main region on some pages: drop it.
  const main = mainRegion(html).replace(/<[^>]+(?:id|class)=["'][^"']*accessib[^"']*["'][\s\S]*$/i, "");
  return main
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "")
    .replace(/<footer[\s\S]*$/i, "")
    .replace(/<\/t[dh]>\s*/gi, " | ")
    .replace(/<\/tr>/gi, "\n")
    // Keep link targets, except action links carrying the session key (never show that).
    .replace(/<a\b[^>]*href=["'](https?:[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, label: string) =>
      /sesskey/i.test(href) ? label : `${label} (${href.replace(/&amp;/g, "&")})`,
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d|section)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .replace(/\n\s*Accessibility\s*\n\s*Reset All[\s\S]*$/, "")
    .trim();
}

const ZOOM_LINK = /https:\/\/[\w.-]*zoom\.us\/(?:j|my|w|s)\/[^\s"'<>)\]]+/gi;

/** Zoom join links in some text/HTML, de-duplicated, with HTML entities undone. */
export function zoomLinks(text: string): string[] {
  return [...new Set((text.match(ZOOM_LINK) ?? []).map((l) => l.replace(/&amp;/g, "&").replace(/[.,;]+$/, "")))];
}

/**
 * A short, token-free description of a page an external tool returned (address without its query
 * values, title, which query parameters it had, scripts and API paths it references). Used to see
 * what a tool like Zoom's shows, without exposing session data.
 */
export function describePage(url: string, html: string): string {
  const u = new URL(url);
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim().slice(0, 80);
  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1].split("?")[0]).slice(0, 6);
  const apis = [...new Set([...html.matchAll(/["'](\/(?:api|lti)\/[\w\/.-]{3,80})/g)].map((m) => m[1]))].slice(0, 12);
  const keys = [...new Set([...html.matchAll(/window\.(__\w+__|\w*(?:state|config|data)\w*)\s*=/gi)].map((m) => m[1]))].slice(0, 8);
  return [
    `${u.host}${u.pathname}`,
    `params: ${[...u.searchParams.keys()].join(",") || "-"}`,
    `title: "${title}"`,
    `${html.length} bytes`,
    `scripts: ${scripts.join(" ") || "-"}`,
    `api paths: ${apis.join(" ") || "-"}`,
    `globals: ${keys.join(",") || "-"}`,
  ].join("; ");
}

const readOnly = { readOnlyHint: true, openWorldHint: false };
const courseArg = z.string().describe("Course name, number or Moodle id");

export function registerMoodleExtras(server: McpServer, ctx: ExtrasContext) {
  const { safe, text, failure, truncate, htmlToText, formatDate } = ctx;

  async function modulesOf(course: MoodleCourse, modname: string) {
    const sections = await ctx.contents(course.id);
    return sections.flatMap((s) => s.modules.filter((m) => m.modname === modname).map((m) => ({ ...m, section: s.name })));
  }

  // ---------- forums ----------
  server.registerTool(
    "get_forum_discussions",
    {
      title: "Course forums and discussions",
      description:
        "Lists a course's forums (Q&A, general discussion, announcements) and their latest discussions, with ids for read_forum_discussion.",
      inputSchema: {
        course: courseArg,
        forum: z.string().optional().describe("Part of a forum's name; omit for all forums"),
        limit: z.number().int().min(1).max(50).default(10).describe("Discussions per forum"),
      },
      annotations: readOnly,
    },
    safe(async ({ course, forum, limit }: { course: string; forum?: string; limit: number }) => {
      const found = await ctx.resolveCourse(course);
      const forums = await ctx.moodle().call<Array<{ id: number; name: string; type: string; numdiscussions?: number }>>(
        "mod_forum_get_forums_by_courses",
        { courseids: [found.id] },
      );
      const chosen = forum ? forums.filter((f) => f.name.toLowerCase().includes(forum.toLowerCase())) : forums;
      if (chosen.length === 0) return text(`No forum${forum ? ` matching "${forum}"` : ""} in ${found.fullname}.`);
      const out: string[] = [found.fullname];
      for (const f of chosen) {
        const result = await ctx.moodle().call<{
          discussions: Array<{ discussion: number; subject: string; created: number; userfullname: string; numreplies?: number; timemodified?: number }>;
        }>("mod_forum_get_forum_discussions", { forumid: f.id, page: 0, perpage: limit });
        out.push(`\n## ${f.name}${f.type === "news" ? " (announcements)" : ""} — forum id ${f.id}`);
        if (result.discussions.length === 0) out.push("(no discussions)");
        for (const d of result.discussions) {
          out.push(`- [discussion ${d.discussion}] ${d.subject} — ${d.userfullname}, ${formatDate(d.created)}${d.numreplies ? `, ${d.numreplies} replies` : ""}`);
        }
      }
      return text(truncate(out.join("\n")));
    }),
  );

  server.registerTool(
    "read_forum_discussion",
    {
      title: "Read a forum discussion",
      description: "Reads every post in a forum discussion (question and all replies). Use the discussion id from get_forum_discussions.",
      inputSchema: { discussion_id: z.number().int().positive() },
      annotations: readOnly,
    },
    safe(async ({ discussion_id }: { discussion_id: number }) => {
      const result = await ctx.moodle().call<{
        posts: Array<{ id: number; subject: string; message: string; timecreated: number; author?: { fullname?: string }; parentid?: number | null }>;
      }>("mod_forum_get_discussion_posts", { discussionid: discussion_id, sortby: "created", sortdirection: "ASC" });
      if (result.posts.length === 0) return text("That discussion has no posts.");
      const posts = result.posts.map(
        (p) => `### ${p.subject} — ${p.author?.fullname ?? "?"}, ${formatDate(p.timecreated)} [post ${p.id}]\n${htmlToText(p.message)}`,
      );
      return text(truncate(posts.join("\n\n")));
    }),
  );

  // ---------- assignment feedback ----------
  server.registerTool(
    "get_assignment_feedback",
    {
      title: "Assignment status, grades and feedback",
      description:
        "For each assignment in a course (or one, by name): whether you've submitted, the grade, and the lecturer's/TA's feedback comments.",
      inputSchema: { course: courseArg, assignment: z.string().optional().describe("Part of the assignment's name") },
      annotations: readOnly,
    },
    safe(async ({ course, assignment }: { course: string; assignment?: string }) => {
      const found = await ctx.resolveCourse(course);
      const result = await ctx.moodle().call<{ courses: Array<{ assignments: Array<{ id: number; name: string; duedate: number }> }> }>(
        "mod_assign_get_assignments",
        { courseids: [found.id] },
      );
      let list = result.courses[0]?.assignments ?? [];
      if (assignment) list = list.filter((a) => a.name.toLowerCase().includes(assignment.toLowerCase()));
      if (list.length === 0) return text(`No matching assignments in ${found.fullname}.`);
      const out: string[] = [found.fullname];
      for (const a of list) {
        const status = await ctx.moodle().call<{
          lastattempt?: { submission?: { status: string; timemodified: number }; gradingstatus?: string };
          feedback?: { gradefordisplay?: string; plugins?: Array<{ type: string; editorfields?: Array<{ text: string }>; fileareas?: Array<{ files?: Array<{ filename: string; fileurl: string }> }> }> };
        }>("mod_assign_get_submission_status", { assignid: a.id });
        const sub = status.lastattempt?.submission;
        const comments = (status.feedback?.plugins ?? [])
          .flatMap((p) => (p.editorfields ?? []).map((e) => htmlToText(e.text)))
          .filter(Boolean)
          .join(" ");
        const feedbackFiles = (status.feedback?.plugins ?? []).flatMap((p) => (p.fileareas ?? []).flatMap((f) => f.files ?? []));
        out.push(
          `\n## ${a.name} (due ${formatDate(a.duedate)})\n` +
            `Submission: ${sub ? `${sub.status}${sub.timemodified ? `, last changed ${formatDate(sub.timemodified)}` : ""}` : "none"}` +
            `${status.lastattempt?.gradingstatus ? ` · grading: ${status.lastattempt.gradingstatus}` : ""}\n` +
            `Grade: ${htmlToText(status.feedback?.gradefordisplay) || "not graded yet"}` +
            (comments ? `\nFeedback: ${comments}` : "") +
            (feedbackFiles.length ? `\nFeedback files: ${feedbackFiles.map((f) => `${f.filename} (${f.fileurl})`).join(", ")}` : ""),
        );
      }
      return text(truncate(out.join("\n")));
    }),
  );

  // ---------- quizzes ----------
  server.registerTool(
    "get_quiz_results",
    {
      title: "Quiz results",
      description: "Your Moodle quizzes in a course: attempts, scores, best grade, and the quiz's feedback for that grade.",
      inputSchema: { course: courseArg },
      annotations: readOnly,
    },
    safe(async ({ course }: { course: string }) => {
      const found = await ctx.resolveCourse(course);
      const result = await ctx.moodle().call<{ quizzes: Array<{ id: number; name: string; grade: number; sumgrades: number; timeclose: number }> }>(
        "mod_quiz_get_quizzes_by_courses",
        { courseids: [found.id] },
      );
      if (result.quizzes.length === 0) return text(`${found.fullname} has no Moodle quizzes.`);
      const out: string[] = [found.fullname];
      for (const q of result.quizzes) {
        const attempts = await ctx.moodle().call<{ attempts: Array<{ attempt: number; state: string; sumgrades: number | null; timefinish: number }> }>(
          "mod_quiz_get_user_attempts",
          { quizid: q.id, status: "all", includepreviews: false },
        );
        const best = await ctx.moodle()
          .call<{ hasgrade: boolean; grade?: number }>("mod_quiz_get_user_best_grade", { quizid: q.id })
          .catch(() => ({ hasgrade: false }) as { hasgrade: boolean; grade?: number });
        let feedback = "";
        if (best.hasgrade && best.grade !== undefined) {
          const fb = await ctx.moodle()
            .call<{ feedbacktext: string }>("mod_quiz_get_quiz_feedback_for_grade", { quizid: q.id, grade: best.grade })
            .catch(() => ({ feedbacktext: "" }));
          feedback = htmlToText(fb.feedbacktext);
        }
        const lines = attempts.attempts.map(
          (t) => `  - attempt ${t.attempt}: ${t.state}${t.sumgrades !== null && q.sumgrades ? `, ${((t.sumgrades / q.sumgrades) * q.grade).toFixed(2)}/${q.grade}` : ""}${t.timefinish ? `, ${formatDate(t.timefinish)}` : ""}`,
        );
        out.push(
          `\n## ${q.name}${q.timeclose ? ` (closes ${formatDate(q.timeclose)})` : ""}\n` +
            `Best grade: ${best.hasgrade ? `${best.grade}/${q.grade}` : "none yet"}${feedback ? `\nFeedback: ${feedback}` : ""}\n` +
            (lines.length ? lines.join("\n") : "  (no attempts)"),
        );
      }
      return text(truncate(out.join("\n")));
    }),
  );

  // ---------- what's new ----------
  server.registerTool(
    "whats_new",
    {
      title: "What's new in my courses",
      description:
        "What changed across your courses recently: new or updated files and activities, new forum posts, new grades. Default: the last 7 days.",
      inputSchema: { days: z.number().int().min(1).max(60).default(7) },
      annotations: readOnly,
    },
    safe(async ({ days }: { days: number }) => {
      const since = Math.floor(Date.now() / 1000) - days * 86400;
      const out: string[] = [];
      for (const course of await ctx.courses()) {
        const updates = await ctx.moodle()
          .call<{ instances: Array<{ contextlevel: string; id: number; updates: Array<{ name: string; timeupdated?: number }> }> }>(
            "core_course_get_updates_since",
            { courseid: course.id, since },
          )
          .catch(() => null);
        if (!updates || updates.instances.length === 0) continue;
        const names = new Map<number, string>();
        for (const s of await ctx.contents(course.id)) for (const m of s.modules) names.set(m.id, m.name);
        const lines = updates.instances
          .filter((i) => i.contextlevel === "module")
          .map((i) => `- ${names.get(i.id) ?? `activity ${i.id}`}: ${i.updates.map((u) => u.name).join(", ")}`);
        if (lines.length) out.push(`## ${course.fullname}\n${lines.join("\n")}`);
      }
      return text(out.length ? truncate(`Changes in the last ${days} days:\n\n${out.join("\n\n")}`) : `Nothing changed in your courses in the last ${days} days.`);
    }),
  );

  // ---------- Zoom ----------
  server.registerTool(
    "get_zoom_links",
    {
      title: "Zoom links",
      description:
        "Zoom meeting links for a course (or all courses): links posted in the course page (e.g. its Zoom section) and, where the course uses the Zoom activity, the meetings listed there.",
      inputSchema: { course: z.string().optional().describe("Course name, number or Moodle id; omit for all courses") },
      annotations: readOnly,
    },
    safe(async ({ course }: { course?: string }) => {
      const list = course ? [await ctx.resolveCourse(course)] : await ctx.courses();
      const out: string[] = [];
      for (const c of list) {
        const lines: string[] = [];
        const sections = await ctx.contents(c.id);
        for (const s of sections) {
          for (const link of zoomLinks(s.summary ?? "")) lines.push(`- ${s.name || "course page"}: ${link}`);
          for (const m of s.modules) {
            const blob = [m.url, m.description, ...(m.contents ?? []).map((f) => f.fileurl)].filter(Boolean).join(" ");
            for (const link of zoomLinks(blob)) lines.push(`- ${m.name}: ${link}`);
          }
        }
        if (ctx.zoomMeetings) {
          for (const s of sections) {
            for (const m of s.modules.filter((m) => m.modname === "lti" && /zoom/i.test(m.name))) {
              try {
                const z = await ctx.zoomMeetings(m.id);
                const fmt = (x: { topic: string; when: string; joinUrl: string | null }) => `    • ${x.topic}${x.when ? ` — ${x.when}` : ""}${x.joinUrl ? ` — ${x.joinUrl}` : ""}`;
                lines.push(
                  `- ${m.name} (Zoom activity): ${z.upcoming.length ? `${z.upcoming.length} upcoming meeting(s)` : "no upcoming meetings listed"}` +
                    (z.upcoming.length ? "\n" + z.upcoming.map(fmt).join("\n") : "") +
                    (z.previous.length ? `\n  Recent:\n${z.previous.map(fmt).join("\n")}` : "") +
                    (z.unrecognised ? `\n  (Zoom answered in an unexpected format: ${z.unrecognised})` : ""),
                );
              } catch (error) {
                const message = (error as Error).message;
                lines.push(
                  /went in circles/.test(message)
                    ? `- ${m.name} (Zoom activity): doesn't open any more (probably left over from an earlier year)`
                    : `- ${m.name} (Zoom activity): couldn't read it (${message})`,
                );
              }
            }
          }
        }
        if (lines.length) out.push(`## ${c.fullname}\n${[...new Set(lines)].join("\n")}`);
      }
      return text(out.length ? truncate(out.join("\n\n")) : "No Zoom links found in your courses' Moodle pages.");
    }),
  );

  // ---------- pages only the website shows (attendance, any Moodle page) ----------
  if (ctx.readMoodlePage) {
    const read = ctx.readMoodlePage;
    server.registerTool(
      "get_attendance",
      {
        title: "Attendance",
        description: "Your attendance record in a course (each session and whether you were marked present, late, absent or excused).",
        inputSchema: { course: courseArg },
        annotations: readOnly,
      },
      safe(async ({ course }: { course: string }) => {
        const found = await ctx.resolveCourse(course);
        const items = await modulesOf(found, "attendance");
        if (items.length === 0) return text(`${found.fullname} doesn't track attendance in Moodle.`);
        const base = ctx.moodle().baseUrl;
        const pages: string[] = [];
        for (const item of items) {
          // view=5: all sessions, not just this week's.
          pages.push(`## ${item.name}\n${await read(`${base}/mod/attendance/view.php?id=${item.id}&view=5`)}`);
        }
        return text(truncate(`${found.fullname} — attendance\n\n${pages.join("\n\n")}`));
      }),
    );

    server.registerTool(
      "read_moodle_page",
      {
        title: "Read a Moodle page",
        description:
          "Reads any page on Reichman's Moodle (a link from another tool, e.g. an activity, a page resource, a book chapter) and returns its text. Read-only.",
        inputSchema: { url: z.string().url().describe("A moodle.runi.ac.il link") },
        annotations: readOnly,
      },
      safe(async ({ url }: { url: string }) => {
        if (new URL(url).origin !== new URL(ctx.moodle().baseUrl).origin) return failure("Only links on Reichman's Moodle can be read with this.");
        return text(truncate(await read(url)));
      }),
    );
  }

  // ---------- actions (each needs the student's approval of a preview) ----------
  const actions = ctx.actions;
  if (!actions) return;
  if (ctx.readLocalFile) {
    const readLocalFile = ctx.readLocalFile;
    server.registerTool(
      "submit_assignment",
      {
        title: "Submit an assignment (needs your OK)",
        description:
          "Prepares a submission to a Moodle assignment: files from the student's computer and/or online text. This does NOT submit: it returns a preview and a confirmation code. Show the preview to the student; only if they explicitly approve it, call confirm_action with the code.",
        inputSchema: {
          course: courseArg,
          assignment: z.string().describe("Part of the assignment's name"),
          files: z.array(z.string()).optional().describe("Paths of files on the student's computer, e.g. '~/Desktop/hw2.pdf'"),
          text: z.string().optional().describe("Online text, if the assignment takes typed text"),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      safe(async ({ course, assignment, files, text: onlineText }: { course: string; assignment: string; files?: string[]; text?: string }) => {
        const found = await ctx.resolveCourse(course);
        const result = await ctx.moodle().call<{ courses: Array<{ assignments: Array<{ id: number; name: string; duedate: number; cutoffdate?: number }> }> }>(
          "mod_assign_get_assignments",
          { courseids: [found.id] },
        );
        const matches = (result.courses[0]?.assignments ?? []).filter((a) => a.name.toLowerCase().includes(assignment.toLowerCase()));
        if (matches.length !== 1) {
          return failure(
            matches.length === 0
              ? `No assignment matching "${assignment}" in ${found.fullname}.`
              : `"${assignment}" matches several: ${matches.map((m) => m.name).join(", ")}. Be more specific.`,
          );
        }
        const target = matches[0];
        if (!files?.length && !onlineText) return failure("Give files to upload and/or the text to submit.");
        const loaded: Array<{ name: string; bytes: Uint8Array }> = [];
        for (const path of files ?? []) loaded.push(await readLocalFile(path));
        const preview =
          `Submit to "${target.name}" in ${found.fullname} (due ${formatDate(target.duedate)}):\n` +
          loaded.map((f) => `- file: ${f.name} (${Math.round(f.bytes.byteLength / 1024)} KB)`).join("\n") +
          (onlineText ? `\n- text: ${onlineText.slice(0, 300)}${onlineText.length > 300 ? "…" : ""}` : "") +
          `\nThis replaces any draft you have there and submits it for grading.`;
        const code = actions.add(preview, async () => {
          const moodle = ctx.moodle();
          let itemid = 0;
          for (const f of loaded) itemid = await moodle.uploadDraftFile(f.name, f.bytes, itemid);
          const params: Record<string, string | number> = { assignmentid: target.id };
          if (loaded.length) params["plugindata[files_filemanager]"] = itemid;
          if (onlineText) {
            params["plugindata[onlinetext_editor][text]"] = onlineText;
            params["plugindata[onlinetext_editor][format]"] = 1;
            params["plugindata[onlinetext_editor][itemid]"] = 0;
          }
          await moodle.call("mod_assign_save_submission", params);
          const submitted = await moodle
            .call<Array<{ item?: string; message?: string }>>("mod_assign_submit_for_grading", { assignmentid: target.id, acceptsubmissionstatement: 1 })
            .catch((error) => [{ message: (error as Error).message }]);
          const warnings = (submitted ?? []).map((w) => w.message).filter(Boolean);
          return `Submitted to "${target.name}".${warnings.length ? ` Moodle notes: ${warnings.join("; ")}` : ""} Check with get_assignment_feedback.`;
        });
        return text(`${preview}\n\nNOT submitted yet. Show this to the student. If they approve, call confirm_action with code ${code}.`);
      }),
    );
  }

  server.registerTool(
    "post_to_forum",
    {
      title: "Post in a course forum (needs your OK)",
      description:
        "Prepares a new discussion in a course forum, or a reply in an existing discussion. This does NOT post: it returns a preview and a confirmation code. Show it to the student; only if they explicitly approve, call confirm_action with the code.",
      inputSchema: {
        course: courseArg,
        message: z.string().min(1),
        subject: z.string().optional().describe("Needed for a new discussion"),
        forum: z.string().optional().describe("Part of the forum's name, for a new discussion"),
        reply_to_discussion: z.number().int().positive().optional().describe("Discussion id to reply in"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ course, message, subject, forum, reply_to_discussion }: { course: string; message: string; subject?: string; forum?: string; reply_to_discussion?: number }) => {
      const found = await ctx.resolveCourse(course);
      if (reply_to_discussion) {
        const posts = await ctx.moodle().call<{ posts: Array<{ id: number; subject: string; parentid?: number | null }> }>(
          "mod_forum_get_discussion_posts",
          { discussionid: reply_to_discussion, sortby: "created", sortdirection: "ASC" },
        );
        const first = posts.posts.find((p) => !p.parentid) ?? posts.posts[0];
        if (!first) return failure("That discussion wasn't found.");
        const preview = `Reply in "${first.subject}" (${found.fullname}):\n${message}`;
        const code = actions.add(preview, async () => {
          await ctx.moodle().call("mod_forum_add_discussion_post", { postid: first.id, subject: `Re: ${first.subject}`, message });
          return `Posted your reply in "${first.subject}".`;
        });
        return text(`${preview}\n\nNOT posted yet. Show this to the student. If they approve, call confirm_action with code ${code}.`);
      }
      if (!subject || !forum) return failure("For a new discussion give `forum` and `subject` (or `reply_to_discussion`).");
      const forums = await ctx.moodle().call<Array<{ id: number; name: string; type: string }>>("mod_forum_get_forums_by_courses", { courseids: [found.id] });
      const target = forums.filter((f) => f.type !== "news" && f.name.toLowerCase().includes(forum.toLowerCase()));
      if (target.length !== 1) return failure(target.length ? `"${forum}" matches several forums: ${target.map((f) => f.name).join(", ")}` : `No forum matching "${forum}" you can post in.`);
      const preview = `New discussion in "${target[0].name}" (${found.fullname}):\nSubject: ${subject}\n${message}`;
      const code = actions.add(preview, async () => {
        await ctx.moodle().call("mod_forum_add_discussion", { forumid: target[0].id, subject, message });
        return `Posted "${subject}" in ${target[0].name}.`;
      });
      return text(`${preview}\n\nNOT posted yet. Show this to the student. If they approve, call confirm_action with code ${code}.`);
    }),
  );
}
