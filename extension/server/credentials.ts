/**
 * Keeps the student's sign-in details in the operating system's own secure storage,
 * the same place browsers and other apps keep saved logins:
 *   - macOS: the login Keychain (built-in `security` tool)
 *   - Windows: encrypted with the user's own Windows account key (DPAPI via PowerShell)
 *   - other systems: a file readable only by this user (fallback)
 *
 * No native modules, so the bundle stays plain JavaScript. Secret values are passed through
 * stdin, never on a command line. The stored value is hex-encoded JSON, so there are no
 * quoting problems whatever characters a password contains.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export interface StoredCredentials {
  reichman?: { username: string; password: string };
  piazza?: { email: string; password: string };
}

const SERVICE = "runi-connector";
const ACCOUNT = "credentials";

export function dataDir(): string {
  if (process.env.RUNI_DATA_DIR) return process.env.RUNI_DATA_DIR; // tests
  const base =
    platform() === "win32"
      ? process.env.APPDATA || join(homedir(), "AppData", "Roaming")
      : platform() === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "runi-connector");
}

const encode = (value: StoredCredentials) => Buffer.from(JSON.stringify(value), "utf8").toString("hex");
const decode = (hex: string): StoredCredentials => JSON.parse(Buffer.from(hex.trim(), "hex").toString("utf8"));

type Backend = "keychain" | "dpapi" | "file";

function backend(): Backend {
  if (process.env.RUNI_CREDENTIALS_BACKEND === "file") return "file"; // tests
  if (platform() === "darwin") return "keychain";
  if (platform() === "win32") return "dpapi";
  return "file";
}

// ---------- macOS Keychain ----------
function keychainRead(): string | null {
  const r = spawnSync("security", ["find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}
function keychainWrite(hex: string) {
  // `security -i` reads commands from stdin, keeping the value off the command line.
  const r = spawnSync("security", ["-i"], {
    input: `add-generic-password -U -a ${ACCOUNT} -s ${SERVICE} -w ${hex}\n`,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error("Couldn't save to the Keychain.");
}
function keychainDelete() {
  spawnSync("security", ["delete-generic-password", "-a", ACCOUNT, "-s", SERVICE], { encoding: "utf8" });
}

// ---------- Windows DPAPI ----------
const dpapiFile = () => join(dataDir(), "credentials.dpapi");
function powershell(script: string, input?: string) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input,
    encoding: "utf8",
  });
}
function dpapiRead(): string | null {
  if (!existsSync(dpapiFile())) return null;
  const script =
    "$e = [Console]::In.ReadToEnd().Trim(); $s = ConvertTo-SecureString $e; " +
    "[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))";
  const r = powershell(script, readFileSync(dpapiFile(), "utf8"));
  return r.status === 0 ? r.stdout.trim() : null;
}
function dpapiWrite(hex: string) {
  const script = "$p = [Console]::In.ReadToEnd().Trim(); ConvertTo-SecureString $p -AsPlainText -Force | ConvertFrom-SecureString";
  const r = powershell(script, hex);
  if (r.status !== 0 || !r.stdout.trim()) throw new Error("Couldn't encrypt the sign-in details.");
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(dpapiFile(), r.stdout.trim(), { mode: 0o600 });
}

// ---------- fallback file ----------
const plainFile = () => join(dataDir(), "credentials.hex");
function fileRead(): string | null {
  return existsSync(plainFile()) ? readFileSync(plainFile(), "utf8") : null;
}
function fileWrite(hex: string) {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(plainFile(), hex, { mode: 0o600 });
  chmodSync(plainFile(), 0o600);
}

// ---------- public API ----------
export function loadCredentials(): StoredCredentials {
  try {
    const raw = { keychain: keychainRead, dpapi: dpapiRead, file: fileRead }[backend()]();
    return raw ? decode(raw) : {};
  } catch {
    return {};
  }
}

export function saveCredentials(creds: StoredCredentials) {
  const hex = encode(creds);
  ({ keychain: keychainWrite, dpapi: dpapiWrite, file: fileWrite })[backend()](hex);
}

export function clearCredentials() {
  keychainDeleteSafe();
  rmSync(dpapiFile(), { force: true });
  rmSync(plainFile(), { force: true });
}

function keychainDeleteSafe() {
  if (backend() === "keychain") keychainDelete();
}

export function storageName(): string {
  return { keychain: "your Mac's Keychain", dpapi: "Windows' encrypted user storage", file: "a private file on this computer" }[backend()];
}
