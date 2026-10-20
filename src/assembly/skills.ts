import { nodeConfigFiles } from "../adapters/fs/index.ts";
import type { ResultEnvelope } from "../generated/types.ts";
import { success } from "../surface/dispatch.ts";
import { failure } from "../surface/result.ts";
import { lintSkill, renderSkills, SKILL_MAX_BYTES } from "../surface/skills.ts";
import type { Assembly } from "./index.ts";

/** Harness-neutral skills directory, relative to the project root. */
export const DEFAULT_SKILLS_DIR = ".agents/skills";

/** `forge skills sync [--dir <path>]`: write each enabled block noun's skill, skipping unchanged files. */
export function syncSkills(
  assembly: Assembly,
  argv: readonly string[],
): ResultEnvelope {
  const [verb, ...rest] = argv;
  let dir = DEFAULT_SKILLS_DIR;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] ?? "";
    const value =
      token === "--dir"
        ? rest[++i]
        : token.startsWith("--dir=")
          ? token.slice(6)
          : undefined;
    if (value === undefined || value === "")
      return failure(
        "INPUT_INVALID",
        `Unexpected argument ${token}. Usage: forge skills sync [--dir <path>]`,
      );
    dir = value;
  }
  if (verb !== "sync")
    return failure(
      "UNKNOWN_COMMAND",
      "Usage: forge skills sync [--dir <path>]",
    );
  dir = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const candidates = assembly.catalog.list();
  const prefix = assembly.exposure.toolPrefix;
  const skills = renderSkills(candidates, prefix);
  const problems = skills.flatMap((skill) =>
    lintSkill(skill.text, candidates, prefix).map((p) => `${skill.path}: ${p}`),
  );
  if (problems.length > 0)
    return failure(
      "OUTPUT_INVALID",
      `Generated skills fail the lint: ${problems.join("; ")}`,
    );
  const files = nodeConfigFiles(assembly.root);
  const written: string[] = [];
  const unchanged: string[] = [];
  try {
    for (const skill of skills) {
      const path = `${dir}/${skill.path}`;
      const bytes = new TextEncoder().encode(skill.text);
      const current = files.read(path, SKILL_MAX_BYTES * 2);
      if (current !== undefined && Buffer.from(current).equals(bytes))
        unchanged.push(path);
      else {
        files.write(path, bytes);
        written.push(path);
      }
    }
  } catch (error) {
    return failure(
      "INPUT_INVALID",
      error instanceof Error ? error.message : "Cannot write skills",
    );
  }
  return success("skills.sync", { dir, written, unchanged });
}
