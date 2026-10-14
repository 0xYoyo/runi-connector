// Syllabi live in Reichman's syllabus generator (behind the My RUNI login), linked from
// each Moodle course page. We can only reach them while the student is signing in, so we
// collect them then and cache the text in KV. Syllabi are course information, not
// personal data, so the cache is shared: the second student in a course gets it for free.

import type { Browser } from "./browser";
import { pdfToText, isPdf } from "./documents";
import type { MoodleCourse } from "./moodle";
import { navigateThroughLogin, type Credentials } from "./reichman-login";

export const DEFAULT_SYLLABUS_URL = "https://my.runi.ac.il/syllabigenerator/pdf/renderdocument?SectionIDC=";
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 150; // about one semester and a bit

export interface CachedSyllabus {
  sectionId: string;
  text: string;
  pages: number;
  fetchedAt: string;
}

const courseKey = (courseId: number) => `course-sections:${courseId}`;
const syllabusKey = (sectionId: string) => `syllabus:${sectionId}`;

export async function sectionIdsForCourse(kv: KVNamespace, courseId: number): Promise<string[]> {
  return (await kv.get<string[]>(courseKey(courseId), "json")) ?? [];
}

export async function cachedSyllabus(kv: KVNamespace, sectionId: string): Promise<CachedSyllabus | null> {
  return kv.get<CachedSyllabus>(syllabusKey(sectionId), "json");
}

export interface HarvestReport {
  coursesChecked: number;
  syllabiFetched: number;
  alreadyCached: number;
  failures: string[];
}

export async function harvestSyllabi(
  kv: KVNamespace,
  browser: Browser,
  moodleBase: string,
  courses: MoodleCourse[],
  credentials: Credentials,
  syllabusUrl = DEFAULT_SYLLABUS_URL,
): Promise<HarvestReport> {
  const report: HarvestReport = { coursesChecked: 0, syllabiFetched: 0, alreadyCached: 0, failures: [] };

  const pause = () => new Promise((resolve) => setTimeout(resolve, 400)); // be gentle with Reichman's servers

  for (const course of courses) {
    report.coursesChecked++;
    if (report.coursesChecked > 1) await pause();
    try {
      let sectionIds = await sectionIdsForCourse(kv, course.id);
      if (sectionIds.length === 0) {
        const page = await browser.request(`${moodleBase}/course/view.php?id=${course.id}`);
        sectionIds = [...new Set([...page.text().matchAll(/SectionIDC=(\d+)/g)].map((m) => m[1]))];
        if (sectionIds.length === 0) continue; // this course has no syllabus link
        await kv.put(courseKey(course.id), JSON.stringify(sectionIds), { expirationTtl: CACHE_TTL_SECONDS });
      }

      for (const sectionId of sectionIds) {
        if (await kv.get(syllabusKey(sectionId), "text")) {
          report.alreadyCached++;
          continue;
        }
        const page = await navigateThroughLogin(browser, syllabusUrl + sectionId, credentials, (p) =>
          isPdf(p.body, p.contentType),
        );
        const { text, pages } = await pdfToText(page.body);
        const entry: CachedSyllabus = { sectionId, text, pages, fetchedAt: new Date().toISOString() };
        await kv.put(syllabusKey(sectionId), JSON.stringify(entry), { expirationTtl: CACHE_TTL_SECONDS });
        report.syllabiFetched++;
      }
    } catch (error) {
      report.failures.push(`${course.fullname}: ${(error as Error).message}`);
    }
  }
  return report;
}
