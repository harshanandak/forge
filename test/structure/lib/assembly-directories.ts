import type { SourceFile, Violation } from "./repo.ts";
import { CODE_FILE } from "./repo.ts";
import { maskLiterals } from "./timeouts.ts";

export function findRawAssemblyDirectories(
  files: readonly SourceFile[],
): Violation[] {
  return files.flatMap(({ path, text }) => {
    if (!path.startsWith("src/assembly/") || !CODE_FILE.test(path)) return [];
    const code = maskLiterals(text);
    const identifier = /\bmkdir(?:Sync)?\b/.exec(code);
    const computed = [
      ...text.matchAll(/\[\s*(["'`])mkdir(?:Sync)?\1\s*\]/g),
    ].find((match) => code[match.index] === "[");
    const match = identifier ?? computed;
    return match === undefined || match === null
      ? []
      : [
          {
            rule: "assembly-directory-durability",
            file: path,
            line: text.slice(0, match.index).split("\n").length,
            message:
              "assembly must create directories through ensurePrivateDirectory in the SQLite adapter",
          },
        ];
  });
}
