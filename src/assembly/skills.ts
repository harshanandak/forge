import { nodeConfigFiles } from "../adapters/fs/index.ts";
import type { McpCandidate } from "../contract/mcp.ts";
import { digest, refuse } from "../core/trust/index.ts";
import { record } from "../surface/dispatch.ts";
import {
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
  /** Unowned files and hand-edited recorded copies are never overwritten. */
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

const OWNERSHIP_FILE = ".forge-skills.json";
const hash = (bytes: Uint8Array): string =>
  digest(bytes.filter((byte, index) => byte !== 13 || bytes[index + 1] !== 10));

function ownership(
  files: ReturnType<typeof nodeConfigFiles>,
  dir: string,
): Record<string, string> {
  const bytes = files.read(`${dir}/${OWNERSHIP_FILE}`);
  if (bytes === undefined) return {};
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const saved = record(record(parsed)?.files);
  if (record(parsed)?.version !== 1 || saved === undefined)
    refuse("INPUT_INVALID", `Invalid skills ownership record in ${dir}`);
  const entries = Object.entries(saved);
  for (const [path, value] of entries)
    if (
      !path.includes("/") ||
      path.includes("\\") ||
      path.split("/").some((part) => ["", ".", ".."].includes(part)) ||
      typeof value !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(value)
    )
      refuse(
        "INPUT_INVALID",
        `Invalid skills ownership entry ${path} in ${dir}`,
      );
  return Object.fromEntries(entries) as Record<string, string>;
}

function readEntry(
  files: ReturnType<typeof nodeConfigFiles>,
  path: string,
): Uint8Array | undefined {
  try {
    return files.read(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EISDIR"))
      throw error;
    return undefined;
  }
}

function tree(
  files: ReturnType<typeof nodeConfigFiles>,
  dir: string,
): { path: string; bytes: Uint8Array }[] {
  readEntry(files, dir);
  return files.list(dir).flatMap((name) => {
    const path = `${dir}/${name}`;
    const bytes = readEntry(files, path);
    return bytes === undefined ? tree(files, path) : [{ path, bytes }];
  });
}

/** Each template's `skills/<name>/SKILL.md`, read from next to the template file and rendered. */
type Copy = SkillFile & { readonly bytes?: Uint8Array };

function templateSkills(templates: TemplateSkills): Copy[] {
  const skills: Copy[] = [];
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
      for (const companion of tree(files, `${dir}/${name}`)) {
        const path = companion.path.slice(dir.length + 1);
        if (path !== `${name}/SKILL.md`)
          skills.push({ noun: name, path, text: "", bytes: companion.bytes });
      }
    }
  }
  return skills;
}

/**
 * `skills.sync`: write each enabled block noun's skill and each imported template's skill under
 * the project root. The ownership record tracks only generated paths and their normalized hashes.
 * Edited copies and unrecorded user files stay untouched.
 */
export function syncSkills(
  root: string,
  candidates: readonly McpCandidate[],
  prefix: string | undefined,
  requested: string | readonly string[] = DEFAULT_SKILLS_DIR,
  templates: TemplateSkills = { sources: [], values: undefined },
  check = false,
): SkillsSyncResult {
  const files = nodeConfigFiles(root);
  let dirs: string[];
  let skills: Copy[];
  try {
    dirs = [
      ...new Set(
        (typeof requested === "string" ? [requested] : requested).map(
          (path) => {
            // Validate before normalizing: neither absolute paths nor .. may disappear.
            files.list(path.replace(/\\/g, "/"));
            return (
              path
                .replace(/\\/g, "/")
                .split("/")
                .filter((part) => part !== "." && part !== "")
                .join("/") || "."
            );
          },
        ),
      ),
    ];
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
    skill.bytes === undefined
      ? lintSkill(skill.text, candidates, prefix).map(
          (p) => `${skill.path}: ${p}`,
        )
      : [],
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
  const differences: string[] = [];
  try {
    const expected = new Map(
      skills.map((skill) => [
        skill.path,
        skill.bytes ?? new TextEncoder().encode(skill.text),
      ]),
    );
    const plans = dirs.map((dir) => {
      const saved = ownership(files, dir);
      const managed = new Set(
        Object.keys(saved).map((path) => path.split("/")[0]),
      );
      const protectedNames = new Set(
        skills
          .filter(
            (skill) =>
              !managed.has(skill.noun) &&
              files.list(`${dir}/${skill.noun}`).length > 0,
          )
          .map((skill) => skill.noun),
      );
      const copies = [...new Set([...paths, ...Object.keys(saved)])].map(
        (path) => {
          const parts = path.split("/");
          for (let index = 1; index < parts.length; index++)
            readEntry(files, `${dir}/${parts.slice(0, index).join("/")}`);
          return { path, current: files.read(`${dir}/${path}`) };
        },
      );
      return { dir, saved, protectedNames, copies };
    });
    for (const { dir, saved, protectedNames, copies } of plans) {
      for (const { path, current } of copies) {
        const target = `${dir}/${path}`;
        const bytes = expected.get(path);
        const previous = saved[path];
        if (
          (previous === undefined && current !== undefined) ||
          protectedNames.has(path.split("/")[0]!)
        ) {
          if (bytes !== undefined) skipped.push(target);
          continue;
        }
        if (current !== undefined && hash(current) !== previous) {
          if (check)
            differences.push(
              `${target}: hand-edited copy; restore its generated content or remove it before syncing`,
            );
          else skipped.push(target);
        } else if (
          bytes !== undefined &&
          current !== undefined &&
          hash(current) === hash(bytes)
        ) {
          unchanged.push(target);
        } else if (bytes !== undefined) {
          if (check)
            differences.push(`${target}: stale copy; run forge skills sync`);
          else {
            files.write(target, bytes);
            saved[path] = hash(bytes);
            written.push(target);
          }
        } else {
          if (check && current !== undefined)
            differences.push(`${target}: stale copy; run forge skills sync`);
          else if (!check) {
            if (current !== undefined) {
              files.remove(target);
              removed.push(target);
            }
            delete saved[path];
          }
        }
      }
      if (!check) {
        const target = `${dir}/${OWNERSHIP_FILE}`;
        const bytes = new TextEncoder().encode(
          `${JSON.stringify({ version: 1, files: Object.fromEntries(Object.entries(saved).sort(([a], [b]) => a.localeCompare(b))) }, null, 2)}\n`,
        );
        const current = files.read(target);
        if (current === undefined || hash(current) !== hash(bytes))
          files.write(target, bytes);
      }
    }
  } catch (error) {
    refuse(
      "INPUT_INVALID",
      error instanceof Error ? error.message : "Cannot write skills",
    );
  }
  if (differences.length) refuse("OUTPUT_INVALID", differences.join("; "));
  return { dir: dirs.join(", "), written, unchanged, skipped, removed };
}
