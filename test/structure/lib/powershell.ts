import type { SourceFile, Violation } from "./repo.ts";

/**
 * Tests and tools start PowerShell through one shared helper (`test/powershell.ts`) so every spawn
 * carries the same startup flags. A cold hosted Windows runner can take several seconds to start
 * powershell.exe; profile loading only adds to that, and a test that spells its own flags can drop
 * them without anyone noticing.
 *
 * Two rules, both read from code lines (comment lines are ignored):
 * - a file that names a PowerShell executable must call the helper (`powerShellArgs(`,
 *   `powerShellBatch(` or `powerShellStep(`); importing it is not enough;
 * - no file but the helper may spell a PowerShell flag, in any letter case.
 * Not detected: a raw spawn without any flag in a file that also calls the helper.
 */

export const HELPER = "test/powershell.ts";
export const REQUIRED_FLAGS = ["-NoProfile", "-NonInteractive"] as const;

/** Files that name PowerShell without spawning it (a process-name list for the runner trace). */
const NAMES_ONLY = new Set(["tools/ci/windows-trace.ts"]);

/** child-step.ts wraps the helper in a batch runner; it must build its arguments through it. */
const BATCH = "test/child-step.ts";

const SCANNED = /^(?:test|tools)\/.+\.[cm]?[jt]s$/;
/** A quoted token that is a PowerShell executable name or a path ending in one. */
const EXECUTABLE =
  /["'`](?:[^"'`\n]*[\\/])?(?:powershell|pwsh)(?:\.exe)?["'`]/i;
const HELPER_CALL = /\bpowerShell(?:Args|Batch|Step)\(/;
const IMPORTS_POWERSHELL = /from\s+["']\.\/powershell\.ts["']/;
const FLAG_LITERAL =
  /(?<![\w-])-(?:NoProfile|NonInteractive|NoLogo|Command|File|EncodedCommand|ExecutionPolicy)(?![\w-])/i;

/** The text with comment-only lines blanked, so line numbers still match. */
function codeOnly(text: string): string {
  return text
    .split("\n")
    .map((line) => (/^\s*(?:\/\/|\/\*|\*)/.test(line) ? "" : line))
    .join("\n");
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

export function findUnsharedPowerShell(
  files: readonly SourceFile[],
): Violation[] {
  const violations: Violation[] = [];
  const helper = files.find((file) => file.path === HELPER);
  if (helper === undefined) {
    violations.push({
      rule: "powershell-spawn",
      file: HELPER,
      message: "the shared PowerShell spawn helper is missing",
    });
  } else {
    for (const flag of REQUIRED_FLAGS)
      if (!helper.text.includes(`"${flag}"`))
        violations.push({
          rule: "powershell-spawn",
          file: HELPER,
          message: `the helper must pass ${flag}`,
        });
  }
  const batch = files.find((file) => file.path === BATCH);
  if (
    batch !== undefined &&
    !(
      IMPORTS_POWERSHELL.test(batch.text) &&
      /\bpowerShellArgs\(/.test(batch.text)
    )
  )
    violations.push({
      rule: "powershell-spawn",
      file: BATCH,
      message: `the batch wrapper must build its arguments through ${HELPER}`,
    });
  for (const file of files) {
    if (
      !SCANNED.test(file.path) ||
      file.path === HELPER ||
      file.path.startsWith("test/structure/") ||
      NAMES_ONLY.has(file.path)
    )
      continue;
    const code = codeOnly(file.text);
    const flag = FLAG_LITERAL.exec(code);
    if (flag !== null)
      violations.push({
        rule: "powershell-spawn",
        file: file.path,
        line: lineOf(code, flag.index),
        message: `spell PowerShell flags through ${HELPER}, not as a literal`,
      });
    const executable = EXECUTABLE.exec(code);
    if (executable !== null && !HELPER_CALL.test(code))
      violations.push({
        rule: "powershell-spawn",
        file: file.path,
        line: lineOf(code, executable.index),
        message: `names a PowerShell executable without calling a helper from ${HELPER}`,
      });
  }
  return violations;
}
