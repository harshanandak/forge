import type { SourceFile, Violation } from "./repo.ts";

/**
 * Tests and tools start PowerShell through one shared helper (`test/powershell.ts`) so every spawn
 * carries the same startup flags. A cold hosted Windows runner can take several seconds to start
 * powershell.exe; profile loading only adds to that, and a test that spells its own flags can drop
 * them without anyone noticing.
 */

export const HELPER = "test/powershell.ts";
export const REQUIRED_FLAGS = ["-NoProfile", "-NonInteractive"] as const;

/** Files that name PowerShell without spawning it (a process-name list for the runner trace). */
const NAMES_ONLY = new Set(["tools/ci/windows-trace.ts"]);

const SCANNED = /^(?:test|tools)\/.+\.[cm]?[jt]s$/;
const EXECUTABLE = /powershell\.exe|(?<![\w./-])pwsh(?:\.exe)?(?![\w-])/i;
/** child-step.ts is the batching wrapper over the helper; importing either reaches it. */
const BATCH = "test/child-step.ts";
const IMPORTS_HELPER =
  /from\s+["'](?:\.{1,2}\/)+(?:[\w.-]+\/)*(?:powershell|child-step)\.ts["']/;
const IMPORTS_POWERSHELL = /from\s+["']\.\/powershell\.ts["']/;
const FLAG_LITERAL = /["']-(?:NoProfile|NonInteractive)["']/;

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
  if (batch !== undefined && !IMPORTS_POWERSHELL.test(batch.text))
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
    const literal = FLAG_LITERAL.exec(file.text);
    if (literal !== null)
      violations.push({
        rule: "powershell-spawn",
        file: file.path,
        line: lineOf(file.text, literal.index),
        message: `spell PowerShell flags through ${HELPER}, not as a literal`,
      });
    const executable = EXECUTABLE.exec(file.text);
    if (executable !== null && !IMPORTS_HELPER.test(file.text))
      violations.push({
        rule: "powershell-spawn",
        file: file.path,
        line: lineOf(file.text, executable.index),
        message: `names a PowerShell executable without importing ${HELPER}`,
      });
  }
  return violations;
}
