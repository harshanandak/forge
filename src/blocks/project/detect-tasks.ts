// Detector for task files (Make and just): the targets and recipes the project declares. A target
// named like a check the project runs is offered as that command; nothing is invented.
import type { DetectionObservation } from "../../generated/types.ts";
import type { ProjectFiles } from "./files.ts";
import { command, detected, firstExisting } from "./observation.ts";

const AREA = "tasks";

const MAKEFILES = ["Makefile", "makefile", "GNUmakefile"];
const JUSTFILES = ["justfile", "Justfile", ".justfile"];

/** Check names the check block understands, with the target names that supply each. */
const COMMAND_TARGETS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["test", ["test", "tests"]],
  ["lint", ["lint"]],
  ["build", ["build"]],
  ["typecheck", ["typecheck", "type-check"]],
  ["format", ["format", "fmt"]],
];

export function makeTargets(text: string): string[] {
  const targets = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (line === "" || /^[\s#]/.test(line)) continue;
    const match = /^([^\s#:=][^:=#]*?)\s*:(?![=:])/.exec(line);
    if (match === null) continue;
    for (const name of (match[1] as string).split(/\s+/)) {
      if (/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name)) targets.add(name);
    }
  }
  return [...targets];
}

const JUST_PARAMETER =
  /(?:\s+[*+$]?[A-Za-z_][\w-]*(?:=(?:"[^"]*"|'[^']*'|\S+))?)*/;
const JUST_RECIPE = new RegExp(
  `^@?([A-Za-z_][\\w-]*)${JUST_PARAMETER.source}\\s*:(?!=)`,
);

export function justRecipes(text: string): string[] {
  const recipes = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (line === "" || /^[\s#]/.test(line)) continue;
    const match = JUST_RECIPE.exec(line);
    if (match !== null) recipes.add(match[1] as string);
  }
  return [...recipes];
}

export function detectTasks(files: ProjectFiles): DetectionObservation[] {
  const out: DetectionObservation[] = [];
  const sources: Array<{
    tool: string;
    invoke: string;
    file: string | undefined;
    names: (text: string) => string[];
  }> = [
    {
      tool: "make",
      invoke: "make",
      file: firstExisting(files, MAKEFILES),
      names: makeTargets,
    },
    {
      tool: "just",
      invoke: "just",
      file: firstExisting(files, JUSTFILES),
      names: justRecipes,
    },
  ];
  for (const { tool, invoke, file, names } of sources) {
    if (file === undefined) continue;
    const declared = names(files.read(file) ?? "");
    out.push(detected(AREA, [tool], { targets: declared }, { file }));
    for (const [check, candidates] of COMMAND_TARGETS) {
      const target = candidates.find((name) => declared.includes(name));
      if (target !== undefined) {
        out.push(
          command(check, `${invoke} ${target}`, {
            file,
            note: `declared ${tool} target ${target}`,
          }),
        );
      }
    }
  }
  return out;
}
