/**
 * Local sign-in: run once (and again whenever Moodle says your access expired).
 *   npm run login
 * Asks for your Reichman username and password, signs in through the university login,
 * and saves ONLY the Moodle app token to ~/.runi-connector/session.json (owner-only).
 * The password is kept in memory for this run and never written anywhere.
 * It also caches your courses' syllabi in ~/.runi-connector/cache.json.
 */
import { createInterface } from "node:readline";
import { MoodleClient } from "../src/moodle";
import { signInToMoodle } from "../src/reichman-login";
import { harvestSyllabi } from "../src/syllabi";
import { DATA_DIR, FileKV, writePrivateFile } from "./file-kv";

const MOODLE_BASE = process.env.MOODLE_BASE ?? "https://moodle.runi.ac.il/2027";

function ask(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s.includes(question)) process.stdout.write(question);
    };
  }
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    }),
  );
}

async function main() {
  const username = (await ask("Reichman username: ")).trim();
  const password = await ask("Password (hidden): ", true);

  console.log("\nSigning in…");
  const { moodleToken, browser } = await signInToMoodle(MOODLE_BASE, { username, password });
  const moodle = new MoodleClient(MOODLE_BASE, moodleToken);
  const site = await moodle.siteInfo();
  const courses = await moodle.courses(site.userid);
  console.log(`✓ Signed in as ${site.fullname} (${courses.length} courses).`);

  const sessionPath = writePrivateFile(
    "session.json",
    JSON.stringify(
      { moodleToken, moodleBase: MOODLE_BASE, userId: site.userid, fullName: site.fullname, savedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  console.log(`✓ Saved your Moodle token (not your password) to ${sessionPath}`);

  console.log("Collecting syllabi…");
  const report = await harvestSyllabi(new FileKV() as unknown as KVNamespace, browser, MOODLE_BASE, courses, {
    username,
    password,
  });
  console.log(
    `✓ Syllabi: ${report.syllabiFetched} downloaded, ${report.alreadyCached} already cached` +
      (report.failures.length ? `, ${report.failures.length} failed:\n  - ${report.failures.join("\n  - ")}` : "."),
  );
  console.log(`\nDone. Data lives in ${DATA_DIR}. Delete that folder any time to sign out.`);
}

main().catch((error) => {
  const err = error as { code?: string; message: string };
  console.error(`✗ ${err.code ? `[${err.code}] ` : ""}${err.message}`);
  process.exit(1);
});
