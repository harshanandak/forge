import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessPort, ProcessResult } from "../../ports/process.ts";

/**
 * Windows ACL changes start System32 `whoami` and `icacls` through the process port with argument
 * arrays, never a shell: PowerShell start-up alone outran the deadline on hosted runners. Each
 * target ends with one protected, explicit full-control entry for the current user.
 */
export async function hardenPrivatePaths(
  paths: readonly string[],
  processPort: ProcessPort,
  env: Readonly<Record<string, string>>,
  platform: string = process.platform,
): Promise<void> {
  if (paths.length === 0 || paths.length > 128)
    throw new Error("Invalid ACL target count");
  if (platform !== "win32") {
    for (const path of paths) chmodSync(path, 0o600);
    return;
  }
  const run = systemTool(processPort, env);
  const user = await run("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
  const sid = /"(S-1-[0-9-]+)"\s*$/.exec(user)?.[1];
  if (sid === undefined) throw failed("current user SID not found");
  // icacls /save writes the DACL as SDDL, which names SIDs whatever the system language.
  const scratch = mkdtempSync(join(tmpdir(), "forge-acl-"));
  try {
    for (const path of paths) {
      const directory = inspect(path);
      const grant = [
        path,
        "/inheritance:r",
        "/grant:r",
        `*${sid}:${directory ? "(OI)(CI)" : ""}F`,
      ];
      const expected = sddlTrustees(sid).map(
        (trustee) => `(A;${directory ? "OICI" : ""};FA;;;${trustee})`,
      );
      const readBack = async (): Promise<string> => {
        const saved = join(scratch, "acl");
        await run("icacls.exe", [path, "/save", saved]);
        return readFileSync(saved, "utf16le").split(/\r?\n/)[1] ?? "";
      };
      await run("icacls.exe", grant);
      let dacl = await readBack();
      if (!isPrivate(dacl, expected)) {
        // /grant:r keeps other trustees' explicit entries. Each is removed by name: every call
        // only takes access away, so a failure part-way never leaves the ACL broader than before.
        const extra = extraTrustees(dacl, sddlTrustees(sid));
        if (extra.allowed.length > 0)
          await run("icacls.exe", [path, "/remove:g", ...extra.allowed]);
        if (extra.denied.length > 0)
          await run("icacls.exe", [path, "/remove:d", ...extra.denied]);
        dacl = await readBack();
      }
      if (!isPrivate(dacl, expected))
        throw failed(`unexpected ACL ${dacl.slice(0, 300)}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** SDDL SID string aliases a process can run as, from Microsoft's "SID strings" list. */
const SID_ALIASES: readonly (readonly [RegExp, string])[] = [
  [/^S-1-5-18$/, "SY"],
  [/^S-1-5-19$/, "LS"],
  [/^S-1-5-20$/, "NS"],
  // The machine's built-in Administrator (RID 500), the account hosted runners use.
  [/^S-1-5-21-\d+-\d+-\d+-500$/, "LA"],
];

/** The forms SDDL may write the current user's SID in. */
function sddlTrustees(sid: string): readonly string[] {
  const alias = SID_ALIASES.find(([pattern]) => pattern.test(sid))?.[1];
  return alias === undefined ? [sid] : [sid, alias];
}

/**
 * Other trustees' allow and deny entries, as icacls `*` names (it takes a SID or an SDDL alias).
 * Anything but plain allow and deny entries is refused rather than guessed at.
 */
function extraTrustees(
  dacl: string,
  own: readonly string[],
): { readonly allowed: readonly string[]; readonly denied: readonly string[] } {
  const body = /^D:[A-Z]*((?:\([^()]*\))*)$/.exec(dacl)?.[1];
  if (body === undefined) throw failed(`unexpected ACL ${dacl.slice(0, 300)}`);
  const allowed = new Set<string>();
  const denied = new Set<string>();
  for (const [, ace = ""] of body.matchAll(/\(([^()]*)\)/g)) {
    const fields = ace.split(";");
    const trustee = fields[5] ?? "";
    if (fields.length !== 6 || !/^[A-Z]{2}$|^S-1-[0-9-]+$/.test(trustee))
      throw failed(`unexpected ACL entry ${ace.slice(0, 300)}`);
    if (fields[0] === "A" && !own.includes(trustee))
      allowed.add(`*${trustee}`);
    else if (fields[0] === "D") denied.add(`*${trustee}`);
    else if (fields[0] !== "A")
      throw failed(`unexpected ACL entry ${ace.slice(0, 300)}`);
  }
  return { allowed: [...allowed], denied: [...denied] };
}

/** Protected, with one expected entry and nothing else. */
function isPrivate(dacl: string, expected: readonly string[]): boolean {
  return expected.some(
    (entry) => dacl === `D:PAI${entry}` || dacl === `D:P${entry}`,
  );
}

/** True for a directory; links and junctions are refused so icacls never follows one. */
function inspect(path: string): boolean {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    throw failed(
      `${path}: ${(error as NodeJS.ErrnoException).code ?? "unreadable"}`,
    );
  }
  if (entry.isSymbolicLink()) throw failed("Reparse target refused");
  return entry.isDirectory();
}

function systemTool(
  processPort: ProcessPort,
  env: Readonly<Record<string, string>>,
): (name: string, args: readonly string[]) => Promise<string> {
  // Pinned to System32: a Git for Windows PATH puts its own whoami.exe first.
  const root = Object.entries(env).find(
    ([name]) => name.toUpperCase() === "SYSTEMROOT",
  )?.[1];
  return async (name, args) => {
    if (root === undefined || root === "")
      throw failed("SystemRoot is not set");
    const executable = processPort.resolve(join(root, "System32", name), env);
    if (executable.kind !== "resolved") throw new Error(executable.reason);
    const result = await processPort.run(executable, args, {
      cwd: process.cwd(),
      env,
      timeoutMs: 30000,
      maxOutputBytes: 4096,
    });
    if (result.exitCode !== 0 || result.timedOut || result.truncated)
      throw failed(`${name} ${failureReason(result)}`);
    return result.stdout;
  };
}

function failed(cause: string): Error {
  return new Error(`Private ACL application or verification failed (${cause})`);
}

function failureReason(result: ProcessResult): string {
  if (result.timedOut) return "timed out";
  if (result.truncated) return "output exceeded its bound";
  const detail = (result.stderr ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  return `exit ${String(result.exitCode)}: ${detail || "no error output"}`;
}
