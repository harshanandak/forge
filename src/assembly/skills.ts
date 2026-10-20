import { nodeConfigFiles } from "../adapters/fs/index.ts";
import type { McpCandidate } from "../contract/mcp.ts";
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
  /** Generated files this run no longer produces, e.g. from a removed template. */
  readonly removed: readonly string[];
}

/** A template file to read skills from: a project file, or one shipped in the installed package. */
export interface TemplateFile {
  readonly root: string;
  readonly file: string;
}

/** Imported template files to read skills from, and the project's effective values. */
export interface TemplateSkills {
  readonly sources: readonly TemplateFile[];
  readonly values: unknown;
}

/** A file's bytes, or undefined when it is missing or not a file (a stray entry in a skills dir). */
function readFile(
  files: ReturnType<typeof nodeConfigFiles>,
  path: string,
): Uint8Array | undefined {
  try {
    return files.read(path);
  } catch {
    return undefined;
  }
}

/** Line endings are normalized first: git autocrlf may have turned a generated file's LF into CRLF. */
const generated = (bytes: Uint8Array | undefined): boolean =>
  bytes !== undefined &&
  new TextDecoder()
    .decode(bytes)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .includes(GENERATED_MARKER);

/** Each template's `skills/<name>/SKILL.md`, read from next to the template file and rendered. */
function templateSkills(templates: TemplateSkills): SkillFile[] {
  const skills: SkillFile[] = [];
  for (const source of templates.sources) {
    const files = nodeConfigFiles(source.root);
    const parent = source.file.split("/").slice(0, -1).join("/");
    const dir = parent === "" ? "skills" : `${parent}/skills`;
    for (const name of files.list(dir)) {
      const bytes = readFile(files, `${dir}/${name}/SKILL.md`);
      if (bytes === undefined) continue;
      const rendered = renderTemplateSkill(
        name,
        new TextDecoder().decode(bytes),
        templates.values,
      );
      if ("unknown" in rendered)
        refuse(
          "INPUT_INVALID",
          `${dir}/${name}/SKILL.md uses unknown values: ${rendered.unknown.join(", ")}`,
        );
      skills.push(rendered);
    }
  }
  return skills;
}

/**
 * `skills.sync`: write each enabled block noun's skill and each imported template's skill under
 * the project root. A file it generated (it carries the marker line) is always replaced, whatever
 * its size, and deleted once no longer produced; a hand-written one is left alone.
 */
export function syncSkills(
  root: string,
  candidates: readonly McpCandidate[],
  prefix: string | undefined,
  requested: string = DEFAULT_SKILLS_DIR,
  templates: TemplateSkills = { sources: [], values: undefined },
): SkillsSyncResult {
  const dir = requested.replace(/\\/g, "/").replace(/\/+$/, "");
  const files = nodeConfigFiles(root);
  let skills: SkillFile[];
  try {
    skills = [
      ...renderSkills(candidates, prefix),
      ...templateSkills(templates),
    ];
  } catch (error) {
    refuse(
      "INPUT_INVALID",
      error instanceof Error ? error.message : "Cannot read template skills",
    );
  }
  const problems = skills.flatMap((skill) =>
    lintSkill(skill.text, candidates, prefix).map((p) => `${skill.path}: ${p}`),
  );
  const paths = skills.map((skill) => skill.path);
  for (const [index, path] of paths.entries())
    if (paths.indexOf(path) !== index)
      problems.push(`${path}: produced by more than one source`);
  if (problems.length > 0)
    refuse(
      "OUTPUT_INVALID",
      `Generated skills fail the lint: ${problems.join("; ")}`,
    );
  const written: string[] = [];
  const unchanged: string[] = [];
  const skipped: string[] = [];
  const removed: string[] = [];
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
    for (const name of files.list(dir)) {
      const path = `${dir}/${name}/SKILL.md`;
      if (paths.includes(`${name}/SKILL.md`)) continue;
      if (!generated(readFile(files, path))) continue;
      files.remove(path);
      removed.push(path);
    }
  } catch (error) {
    refuse(
      "INPUT_INVALID",
      error instanceof Error ? error.message : "Cannot write skills",
    );
  }
  return { dir, written, unchanged, skipped, removed };
}
