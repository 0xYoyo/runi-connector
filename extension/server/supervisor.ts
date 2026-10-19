// The launcher: a small, fixed process that Claude (or ChatGPT) talks to. It runs the real
// connector as a child process and passes MCP messages (one JSON object per line on stdin/stdout)
// straight through. When a newer version has been downloaded and verified (updates.ts), it starts
// the new version next to the old one, replays the MCP handshake to it, waits until no request is
// in flight, and switches over. The app never has to be restarted for an update.
//
// Safety nets: a new version that fails to start is marked bad and the old one keeps running; a
// child that crashes is restarted (falling back to the built-in version if it keeps crashing).

import { spawn, type ChildProcess } from "node:child_process";
import { downloadLatest, markBad, markHealthy, pickDownloadedVersion } from "./updates";

type Line = string;

interface Child {
  proc: ChildProcess;
  version: string;
  file: string;
}

export interface SupervisorOptions {
  selfPath: string; // this program's own file (the built-in version)
  selfVersion: string;
  dataDir: string;
  log: (...parts: unknown[]) => void;
  checkEveryMs: number; // periodic update check
  updates: boolean; // false: never look for updates (tests, RUNI_NO_SELF_UPDATE)
}

// Splits a stream into lines.
function onLines(stream: NodeJS.ReadableStream, handle: (line: Line) => void) {
  let buffer = "";
  stream.setEncoding?.("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line.trim()) handle(line);
    }
  });
}

const INTERNAL_INIT_ID = "__runi_internal_initialize__";
const idKey = (id: unknown) => JSON.stringify(id);

export function supervise(options: SupervisorOptions) {
  const { log } = options;
  let current: Child;
  let initializeLine: Line | null = null; // the client's initialize request, to replay to a new child
  let initializeId: string | null = null;
  let initializedLine: Line | null = null; // and its "initialized" notification
  const pending = new Set<string>(); // ids of client requests the current child hasn't answered
  let swapping = false;
  let shuttingDown = false;
  const crashes: number[] = [];

  const best = (): { file: string; version: string } =>
    (options.updates && pickDownloadedVersion(options.dataDir, options.selfVersion)) || { file: options.selfPath, version: options.selfVersion };

  function start(file: string, version: string): Child {
    const proc = spawn(process.execPath, [file], {
      env: { ...process.env, RUNI_CHILD: "1" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const child: Child = { proc, version, file };
    onLines(proc.stdout!, (line) => fromChild(child, line));
    proc.on("exit", (code) => onChildExit(child, code));
    proc.stdin!.on("error", () => {}); // a dying child must not take the launcher down
    return child;
  }

  function send(child: Child, line: Line) {
    child.proc.stdin!.write(line + "\n");
  }

  // --- messages from Claude ---
  onLines(process.stdin, (line) => {
    let message: { id?: unknown; method?: string } | null = null;
    try {
      message = JSON.parse(line);
    } catch {
      /* pass through as-is */
    }
    if (message?.method === "initialize") {
      initializeLine = line;
      initializeId = idKey(message.id);
    }
    if (message?.method === "notifications/initialized") initializedLine = line;
    if (message?.method && message.id !== undefined) pending.add(idKey(message.id));
    send(current, line);
    if (message?.method && message.id !== undefined) void maybeCheckForUpdate();
  });
  process.stdin.on("end", () => {
    shuttingDown = true;
    current?.proc.kill();
    process.exit(0);
  });

  // --- messages from the connector ---
  const internalWaiters = new Map<Child, (ok: boolean) => void>();
  function fromChild(child: Child, line: Line) {
    let message: { id?: unknown; method?: string; result?: unknown } | null = null;
    try {
      message = JSON.parse(line);
    } catch {
      /* not JSON: forward if it's the current child */
    }
    if (message?.id === INTERNAL_INIT_ID) {
      internalWaiters.get(child)?.(Boolean(message.result));
      return; // our own replayed handshake: Claude never sees it
    }
    if (child !== current) return; // an old child finishing up; it has no requests left
    if (message && message.id !== undefined && !message.method) {
      pending.delete(idKey(message.id));
      // The connector answered Claude's hello: this version works.
      if (idKey(message.id) === initializeId && message.result) {
        markHealthy(options.dataDir, child.version);
        if (process.env.RUNI_LAUNCHED) markHealthy(options.dataDir, process.env.RUNI_LAUNCHED);
      }
    }
    process.stdout.write(line + "\n");
  }

  // Replays the client's handshake to a fresh child. Resolves true if it answered.
  function handshake(child: Child, timeoutMs = 20_000): Promise<boolean> {
    if (!initializeLine) return Promise.resolve(true); // the client hasn't said hello yet
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        internalWaiters.delete(child);
        resolve(false);
      }, timeoutMs);
      internalWaiters.set(child, (ok) => {
        clearTimeout(timer);
        internalWaiters.delete(child);
        if (ok && initializedLine) send(child, initializedLine);
        resolve(ok);
      });
      const init = JSON.parse(initializeLine!);
      init.id = INTERNAL_INIT_ID;
      send(child, JSON.stringify(init));
    });
  }

  function onChildExit(child: Child, code: number | null) {
    if (shuttingDown || child !== current || swapping) return;
    log(`connector v${child.version} stopped (code ${code}); restarting it`);
    // Requests it was handling won't get an answer: tell Claude so it can retry.
    for (const key of pending) {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(key), error: { code: -32603, message: "The connector restarted; please try again." } }) + "\n",
      );
    }
    pending.clear();
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && now - crashes[0] > 60_000) crashes.shift();
    // Crashing again and again: give up on that version and use the built-in one.
    if (crashes.length >= 3 && child.file !== options.selfPath) {
      markBad(options.dataDir, child.version);
      log(`v${child.version} keeps crashing; marked bad, using the built-in v${options.selfVersion}`);
    }
    const next = crashes.length >= 5 ? { file: options.selfPath, version: options.selfVersion } : best();
    current = start(next.file, next.version);
    void handshake(current);
  }

  // --- updates ---
  async function swapTo(file: string, version: string) {
    if (swapping || version === current.version) return;
    swapping = true;
    try {
      const fresh = start(file, version);
      const ok = await handshake(fresh);
      if (!ok) {
        fresh.proc.kill();
        markBad(options.dataDir, version);
        log(`v${version} didn't start; keeping v${current.version}`);
        return;
      }
      // Switch only between requests, so nothing in flight is lost.
      const deadline = Date.now() + 120_000;
      while (pending.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      if (pending.size > 0) {
        fresh.proc.kill();
        return; // busy for too long; try again at the next check
      }
      const old = current;
      current = fresh;
      markHealthy(options.dataDir, version);
      log(`switched to v${version} (was v${old.version}) without a restart`);
      old.proc.stdin!.end();
      setTimeout(() => old.proc.kill(), 5_000).unref();
      // New versions can add tools: ask Claude to refresh its list.
      if (initializeLine) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }) + "\n");
    } finally {
      swapping = false;
    }
  }

  let lastCheck = 0;
  async function checkForUpdate() {
    lastCheck = Date.now();
    if (!options.updates) return;
    await downloadLatest(options.dataDir, current.version).catch((error) => log("update download rejected:", (error as Error).message));
    const candidate = pickDownloadedVersion(options.dataDir, current.version);
    if (candidate) await swapTo(candidate.file, candidate.version);
  }
  // Also check when Claude uses a tool (at most every 2 minutes), so updates arrive quickly.
  async function maybeCheckForUpdate() {
    if (Date.now() - lastCheck > 120_000) await checkForUpdate();
  }

  // Loaded by an older launcher (it set RUNI_LAUNCHED): we're up, so tell it this version is
  // fine right away; older launchers would otherwise skip us if this process gets closed early.
  if (process.env.RUNI_LAUNCHED) markHealthy(options.dataDir, process.env.RUNI_LAUNCHED);

  const first = best();
  current = start(first.file, first.version);
  if (options.updates) {
    setTimeout(() => void checkForUpdate(), 3_000).unref();
    setInterval(() => void checkForUpdate(), options.checkEveryMs).unref();
  }
  return { currentVersion: () => current.version };
}
