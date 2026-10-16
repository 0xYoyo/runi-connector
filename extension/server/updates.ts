// Checks GitHub for a newer release, so the connector can tell the user to update.
// Best-effort and silent on any failure (offline, rate-limited, etc.).

const REPO = "0xYoyo/runi-connector";
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

export interface UpdateInfo {
  current: string;
  latest: string;
  url: string;
}

// "1.2.3" → [1,2,3]; compares numerically so 0.10.0 > 0.9.0.
function cmp(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

export async function checkForUpdate(current: string, timeoutMs = 4000): Promise<UpdateInfo | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "runi-connector" },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: string; html_url?: string };
    const latest = data.tag_name?.replace(/^v/, "");
    if (!latest || cmp(latest, current) <= 0) return null;
    return { current, latest, url: data.html_url || RELEASES_PAGE };
  } catch {
    return null;
  }
}

export function updateNotice(info: UpdateInfo): string {
  return (
    `UPDATE AVAILABLE: a newer version of this connector (v${info.latest}, you have v${info.current}) is out. ` +
    `Tell the user once, conversationally, that they can update by downloading the latest installer from ${info.url} ` +
    `and double-clicking it (their saved login carries over). Don't repeat this every message.`
  );
}
