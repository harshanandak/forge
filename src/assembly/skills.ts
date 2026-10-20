import { nodeConfigFiles } from "../adapters/fs/index.ts";
import type { McpCandidate } from "../contract/mcp.ts";
import { TEMPLATE_SKILLS_DIR } from "../core/config/index.ts";
import { refuse } from "../core/trust/index.ts";
import {
  GENERATED_MARKER,
  lintSkill,
  renderSkills,
  renderTemplateSkill,
  type SkillFile,
} from "../surface/skills.ts";

/** Harness-neutral skills directory, relative to the project root. */
export const DEFAULT_SKILLS_DIR = ".agents/skills";

export interface SkillsSyncResult {
  readonly dir: string;
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  /** Existing files without the generated marker: hand-written, so never overwritten. */
  readonly skipped: readonly string[];
}

/** The template skills the project config lists, with the effective values they render from. */
export interface TemplateSkills {
  readonly skills: readonly string[];
  readonly values: unknown;
}

const generated = (bytes: Uint8Array | undefined): boolean =>
  bytes !== undefined &&
  new TextDecoder().decode(bytes).split("\n").includes(GENERATED_MARKER);

/** Each listed template skill, read from where import copied it and rendered with the values. */
function renderListed(
  root: string,
  template: TemplateSkills,
): readonly SkillFile[] {
  const files = nodeConfigFiles(root);
  return template.skills.map((name) => {
    const path = `${TEMPLATE_SKILLS_DIR}/${name}/SKILL.md`;
    const bytes = files.read(path);
    if (bytes === undefined)
      refuse(
        "INPUT_INVALID",
        `Skill ${name} is listed, but ${path} does not exist`,
      );
    const rendered = renderTemplateSkill(
      name,
      new TextDecoder().decode(bytes),
      template.values,
    );
    if ("unknown" in rendered)
      refuse(
        "INPUT_INVALID",
        `${path} has unknown placeholders: ${rendered.unknown.join(", ")}`,
      );
    return rendered;
  });
}

/**
 * `skills.sync`: write each enabled block noun's skill, and each template skill the config lists,
 * under the project root. A file it generated (it carries the marker line) is always replaced,
 * whatever its size; a hand-written one is left alone.
 */
export function syncSkills(
  root: string,
  candidates: readonly McpCandidate[],
  prefix: string | undefined,
  requested: string = DEFAULT_SKILLS_DIR,
  template: TemplateSkills = { skills: [], values: {} },
): SkillsSyncResult {
  const dir = requested.replace(/\\/g, "/").replace(/\/+$/, "");
  const nouns = renderSkills(candidates, prefix);
  const listed = renderListed(root, template);
  const clash = listed.find((s) => nouns.some((n) => n.path === s.path));
  if (clash !== undefined)
    refuse(
      "INPUT_INVALID",
      `Template skill ${clash.noun} has the name of a generated block skill`,
    );
  const skills = [...nouns, ...listed];
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
  const skipped: string[] = [];
  try {
    for (const skill of skills) {
      const path = `${dir}/${skill.path}`;
      const bytes = new TextEncoder().encode(skill.text);
      const current = files.read(path);
      if (current !== undefined && Buffer.from(current).equals(bytes))
        unchanged.push(path);
      else if (current !== undefined && !generated(current)) skipped.push(path);
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
  return { dir, written, unchanged, skipped };
}

/**
 * After template.remove: for each skill the config no longer lists, delete the import's copy and
 * the rendered file when it carries the generated marker. Hand-written files stay.
 */
export function removeTemplateSkills(
  root: string,
  names: readonly string[],
): void {
  const files = nodeConfigFiles(root);
  for (const name of names) {
    files.remove(`${TEMPLATE_SKILLS_DIR}/${name}/SKILL.md`);
    const path = `${DEFAULT_SKILLS_DIR}/${name}/SKILL.md`;
    if (generated(files.read(path))) files.remove(path);
  }
}
