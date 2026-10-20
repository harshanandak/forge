import { nodeConfigFiles } from "../adapters/fs/index.ts";
import type { McpCandidate } from "../contract/mcp.ts";
import { refuse } from "../core/trust/index.ts";
import { lintSkill, renderSkills, SKILL_MAX_BYTES } from "../surface/skills.ts";

/** Harness-neutral skills directory, relative to the project root. */
export const DEFAULT_SKILLS_DIR = ".agents/skills";

export interface SkillsSyncResult {
  readonly dir: string;
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
}

/** `skills.sync`: write each enabled block noun's skill under the project root, skipping unchanged files. */
export function syncSkills(
  root: string,
  candidates: readonly McpCandidate[],
  prefix: string | undefined,
  requested: string = DEFAULT_SKILLS_DIR,
): SkillsSyncResult {
  const dir = requested.replace(/\\/g, "/").replace(/\/+$/, "");
  const skills = renderSkills(candidates, prefix);
  const problems = skills.flatMap((skill) =>
    lintSkill(skill.text, candidates, prefix).map((p) => `${skill.path}: ${p}`),
  );
  if (problems.length > 0)
    refuse(
      "OUTPUT_INVALID",
      `Generated skills fail the lint: ${problems.join("; ")}`,
    );
  const files = nodeConfigFiles(root);
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
    refuse(
      "INPUT_INVALID",
      error instanceof Error ? error.message : "Cannot write skills",
    );
  }
  return { dir, written, unchanged };
}
