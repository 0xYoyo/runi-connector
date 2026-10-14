/**
 * Run this ONCE on your own machine against the real Reichman login to confirm the
 * server-side sign-in works before deploying. It answers the three open questions:
 *   1. Does the Moodle launch.php flow actually hand back an app token?
 *   2. Is there a 2FA step in the way?
 *   3. How long does the token stay valid? (save the printed token privately and
 *      re-run with --verify in a few days/weeks to see if it still works)
 *
 * Usage:
 *   npx tsx scripts/probe-login.ts
 *   (it prompts for username and password; nothing is written to disk)
 *
 *   npx tsx scripts/probe-login.ts --verify <token>
 *   (checks whether a token printed earlier still works — for measuring lifetime)
 *
 * The password is read from a hidden prompt and kept only in memory.
 */
import { createInterface } from "node:readline";
import { signInToMoodle } from "../src/reichman-login";
import { MoodleClient } from "../src/moodle";
import { Browser } from "../src/browser";
import { createHash } from "node:crypto";

const MOODLE_BASE = process.env.MOODLE_BASE ?? "https://moodle.runi.ac.il/2027";

// Reads a line from the terminal. With hidden=true, typed characters are not echoed.
function ask(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    // Only print the prompt itself; swallow the echo of each typed character.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s.includes(question)) process.stdout.write(question);
    };
  }
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function verify(token: string) {
  const moodle = new MoodleClient(MOODLE_BASE, token);
  try {
    const site = await moodle.siteInfo();
    console.log(`✓ Token still valid — signed in as ${site.fullname} (user ${site.userid}).`);
  } catch (error) {
    console.log(`✗ Token no longer works: ${(error as Error).message}`);
  }
}

async function main() {
  const verifyFlag = process.argv.indexOf("--verify");
  if (verifyFlag !== -1) {
    await verify(process.argv[verifyFlag + 1]);
    return;
  }

  const username = await ask("Reichman username: ");
  const password = await ask("Password (hidden): ", true);

  console.log("\nSigning in through the university login…\n");
  const start = Date.now();
  const browser = new Browser();
  try {
    const { moodleToken } = await signInToMoodle(MOODLE_BASE, { username, password }, { browser });
    console.log(`✓ Got a Moodle token in ${((Date.now() - start) / 1000).toFixed(1)}s.`);
    console.log(`  token fingerprint: ${createHash("sha256").update(moodleToken).digest("hex").slice(0, 16)}`);

    const moodle = new MoodleClient(MOODLE_BASE, moodleToken);
    const site = await moodle.siteInfo();
    const courses = await moodle.courses(site.userid);
    console.log(`✓ Signed in as ${site.fullname}; ${courses.length} courses.`);
    console.log(`\nTo test token lifetime, save the token somewhere private and later run:`);
    console.log(`  npx tsx scripts/probe-login.ts --verify ${moodleToken}`);
    console.log(`\nStep trace (host — path — status):`);
    for (const t of browser.trace) console.log(`  ${t.status}  ${t.method.padEnd(4)} ${t.host}${t.path}`);
  } catch (error) {
    const err = error as { code?: string; message: string };
    console.log(`✗ ${err.code ? `[${err.code}] ` : ""}${err.message}`);
    if (err.code === "mfa_required") {
      console.log("  → The university login has a 2FA step. Send this output to the maintainer; the flow needs a 2FA prompt added.");
    }
    console.log(`\nStep trace so far:`);
    for (const t of browser.trace) console.log(`  ${t.status}  ${t.method.padEnd(4)} ${t.host}${t.path}`);
    process.exitCode = 1;
  }
}

main();
