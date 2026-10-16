/**
 * Reichman runs one Moodle per academic year, named after the year it ends
 * (2026/27 → moodle.runi.ac.il/2027). Returns the current year's address first and the
 * previous year's as a fallback, unless MOODLE_BASE overrides it.
 */
export function moodleBaseCandidates(now = new Date()): string[] {
  const override = process.env.MOODLE_BASE?.trim();
  if (override) return [override];
  const year = now.getFullYear();
  const academicYear = now.getMonth() >= 7 ? year + 1 : year; // from August on, it's next year's Moodle
  return [academicYear, academicYear - 1].map((y) => `https://moodle.runi.ac.il/${y}`);
}
