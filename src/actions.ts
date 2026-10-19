// Actions that change something (submit, post, send) never run when the AI first asks. The tool
// returns a preview and a short code. The action only runs when confirm_action gets that code,
// which the AI is told to send only after the student explicitly approves the preview.
// Codes are random, single-use and expire after 15 minutes.

interface Pending {
  preview: string;
  run: () => Promise<string>;
  expires: number;
}

const TTL_MS = 15 * 60_000;

export class PendingActions {
  private readonly items = new Map<string, Pending>();

  add(preview: string, run: () => Promise<string>): string {
    this.prune();
    const bytes = crypto.getRandomValues(new Uint8Array(3));
    const code = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
    this.items.set(code, { preview, run, expires: Date.now() + TTL_MS });
    return code;
  }

  /** Runs the action for `code` once. Returns null if the code is unknown or expired. */
  async confirm(code: string): Promise<{ preview: string; result: string } | null> {
    this.prune();
    const key = code.trim().toUpperCase();
    const item = this.items.get(key);
    if (!item) return null;
    this.items.delete(key); // single use, even if it fails
    return { preview: item.preview, result: await item.run() };
  }

  cancel(code: string): boolean {
    return this.items.delete(code.trim().toUpperCase());
  }

  private prune() {
    const now = Date.now();
    for (const [code, item] of this.items) if (item.expires < now) this.items.delete(code);
  }
}
