import type { SourceFile, Violation } from "./repo.ts";
import { maskLiterals } from "./timeouts.ts";

const PROCESS_CALL =
  /\b(?:spawn|spawnSync|execSync|execFile|execFileSync|fork|createProcessPort|listRepoFiles)\s*\(|(?<![\w.])exec\s*\(|\bBun\.spawn(?:Sync)?\s*\(/;

export function findMisplacedProcessTests(
  files: readonly SourceFile[],
): Violation[] {
  return files.flatMap(({ path, text }) => {
    if (
      !path.startsWith("test/") ||
      !path.endsWith(".test.ts") ||
      path.endsWith(".integration.test.ts")
    )
      return [];
    const match = PROCESS_CALL.exec(maskLiterals(text));
    return match === null
      ? []
      : [
          {
            rule: "process-test-lane",
            file: path,
            line: text.slice(0, match.index).split("\n").length,
            message:
              "a test that starts a real process must use the .integration.test.ts suffix",
          },
        ];
  });
}
