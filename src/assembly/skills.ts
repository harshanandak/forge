import {
  entryKind,
  nodeConfigFiles,
  removeEmptyParents,
} from "../adapters/fs/index.ts";
import type { McpCandidate } from "../contract/mcp.ts";
import { ForgeFailure } from "../contract/failure.ts";
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
  /** Unmarked skills and conflicting unlisted companions, left untouched. */
  readonly skipped: readonly string[];
  /** Generated files this run no longer produces, e.g. from a removed template. */
  readonly removed: readonly string[];
  readonly differences: readonly string[];
  readonly readErrors: readonly string[];
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
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["EISDIR", "ENOTDIR"].includes(String(error.code))
    )
      return undefined;
    throw error;
  }
}

/** Line endings are normalized first: git autocrlf may have turned a generated file's LF into CRLF. */
const lines = (bytes: Uint8Array): string[] =>
  new TextDecoder().decode(bytes).replace(/\r\n/g, "\n").split("\n");
const key = (name: string): string =>
  ["win32", "darwin"].includes(process.platform) ? name.toLowerCase() : name;
const companionLine = (paths: readonly string[]): string =>
  `<!-- forge companions: ${paths.join(", ")} -->`;
const equal = (a: Uint8Array, b: Uint8Array): boolean => {
  const normalize = (bytes: Uint8Array): Uint8Array =>
    bytes.includes(0)
      ? bytes
      : bytes.filter((byte, i) => byte !== 13 || bytes[i + 1] !== 10);
  return Buffer.from(normalize(a)).equals(normalize(b));
};

function validate(root: string, path: string, origin: string): boolean {
  if (
    /[\\:,\r\n]/.test(path) ||
    path !== path.trim() ||
    path.split("/").some((part) => ["", ".", ".."].includes(part)) ||
    key(path) === key("SKILL.md")
  )
    throw new Error(`Invalid companion path ${path} in ${origin}`);
  // Probe every component as a final component, so even an internal link is refused.
  const parts = path.split("/");
  try {
    let clear = true;
    for (let i = 1; i <= parts.length; i++) {
      const kind = entryKind(root, parts.slice(0, i).join("/"));
      if (kind === "link") throw new Error("symlinked path is not followed");
      if (i < parts.length && kind !== "missing" && kind !== "directory")
        clear = false;
    }
    return clear;
  } catch (error) {
    throw new Error(
      `Invalid companion path ${path} in ${origin}: ${error instanceof Error ? error.message : "cannot inspect path"}`,
      { cause: error },
    );
  }
}

function companions(
  bytes: Uint8Array | undefined,
  origin: string,
): string[] | undefined {
  if (bytes === undefined) return undefined;
  const text = lines(bytes);
  const index = text.indexOf(GENERATED_MARKER);
  if (index < 0) return undefined;
  const next = text[index + 1] ?? "";
  if (!next.startsWith("<!-- forge companions:")) return [];
  const match = /^<!-- forge companions: (.+) -->$/.exec(next);
  if (!match) throw new Error(`Invalid companion list ${next} in ${origin}`);
  return match[1]!.split(",").map((path) => path.trim());
}

type Copy = SkillFile & { readonly bytes?: Uint8Array };
function tree(
  files: ReturnType<typeof nodeConfigFiles>,
  dir: string,
): { path: string; bytes: Uint8Array }[] {
  readFile(files, dir);
  return files.list(dir).flatMap((name) => {
    const path = `${dir}/${name}`;
    const bytes = readFile(files, path);
    return bytes === undefined ? tree(files, path) : [{ path, bytes }];
  });
}

/** Each template's `skills/<name>/SKILL.md`, read from next to the template file and rendered. */
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
      const extras = tree(files, `${dir}/${name}`).filter(
        (file) => key(file.path) !== key(`${dir}/${name}/SKILL.md`),
      );
      skills.push(rendered);
      for (const file of extras)
        skills.push({
          noun: name,
          path: file.path.slice(dir.length + 1),
          text: "",
          bytes: file.bytes,
        });
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
  requested: string | readonly string[] = DEFAULT_SKILLS_DIR,
  templates: TemplateSkills = { sources: [], values: undefined },
  check = false,
): SkillsSyncResult {
  const files = nodeConfigFiles(root);
  let dirs: string[];
  let skills: Copy[];
  try {
    const unique = new Map<string, string>();
    for (const path of typeof requested === "string"
      ? [requested]
      : requested) {
      files.list(path.replace(/\\/g, "/"));
      const dir =
        path
          .replace(/\\/g, "/")
          .split("/")
          .filter((part) => part !== "." && part !== "")
          .join("/") || ".";
      unique.set(key(dir), dir);
    }
    dirs = [...unique.values()];
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
    if (paths.findIndex((other) => key(other) === key(path)) !== index)
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
  const readErrors: string[] = [];
  try {
    const writes: { path: string; bytes: Uint8Array }[] = [];
    const ownershipWrites: typeof writes = [];
    const deletes: { path: string; folder: string }[] = [];
    // Plan every directory first. Invalid metadata must not leave a partial sync.
    for (const dir of dirs) {
      const names = new Map(
        [...files.list(dir), ...skills.map((s) => s.noun)].map((name) => [
          key(name),
          name,
        ]),
      );
      for (const name of names.values()) {
        const folder = `${dir}/${name}`;
        const copies = skills.filter((s) => key(s.noun) === key(name));
        const kind = entryKind(root, folder);
        if (kind !== "directory" && kind !== "missing") {
          if (copies.length) skipped.push(folder);
          continue;
        }
        const localRoot = `${root}/${folder}`;
        const local = nodeConfigFiles(localRoot);
        const path = `${folder}/SKILL.md`;
        const skillKind = entryKind(localRoot, "SKILL.md");
        let current: Uint8Array | undefined;
        try {
          current = skillKind === "file" ? local.read("SKILL.md") : undefined;
        } catch (error) {
          // A size cap does not establish ownership; leave the whole folder alone.
          if (!(
            error instanceof ForgeFailure &&
            error.error.code === "LIMIT_EXCEEDED"
          ))
            readErrors.push(
              `${path}: ${error instanceof Error ? error.message : String(error)}`,
            );
          continue;
        }
        const listed = companions(current, path);
        if (listed === undefined && skillKind !== "missing") {
          if (copies.length) skipped.push(path);
          continue;
        }
        for (const entry of listed ?? []) validate(localRoot, entry, path);
        const wanted = new Map(
          copies.map((s) => [key(s.path.slice(s.noun.length + 1)), s]),
        );
        const adopted: string[] = [];
        for (const [relative, copy] of wanted) {
          if (relative === key("SKILL.md")) continue;
          const destination = copy.path.slice(copy.noun.length + 1);
          const clear = validate(localRoot, destination, path);
          const bytes = copy.bytes!;
          const displaced = (listed ?? []).some(
            (p) =>
              !wanted.has(key(p)) &&
              key(destination).startsWith(`${key(p)}/`) &&
              entryKind(localRoot, p) === "file",
          );
          if (
            !displaced &&
            (!clear ||
              !["missing", "file"].includes(entryKind(localRoot, destination)))
          ) {
            skipped.push(`${folder}/${destination}`);
            continue;
          }
          const existing = displaced ? undefined : readFile(local, destination);
          if (
            existing !== undefined &&
            !(listed ?? []).some((p) => key(p) === relative) &&
            !equal(existing, bytes)
          ) {
            skipped.push(`${folder}/${destination}`);
            continue;
          }
          adopted.push(destination);
        }
        for (const relative of listed ?? []) {
          if (wanted.has(key(relative))) continue;
          const target = `${folder}/${relative}`;
          if (readFile(local, relative) !== undefined) {
            deletes.push({ path: target, folder });
            differences.push(target);
          }
        }
        if (!copies.length) {
          if (listed !== undefined) {
            deletes.push({ path, folder });
            differences.push(path);
          }
          continue;
        }
        for (const copy of copies) {
          const relative = copy.path.slice(copy.noun.length + 1);
          if (copy.bytes !== undefined && !adopted.includes(relative)) continue;
          let bytes = copy.bytes;
          if (bytes === undefined) {
            bytes = new TextEncoder().encode(
              copy.text.replace(
                GENERATED_MARKER,
                `${GENERATED_MARKER}${adopted.length ? `\n${companionLine(adopted)}` : ""}`,
              ),
            );
          }
          const target = `${folder}/${relative}`;
          const existing = readFile(local, relative);
          if (existing !== undefined && equal(existing, bytes))
            unchanged.push(target);
          else {
            (copy.bytes === undefined ? ownershipWrites : writes).push({
              path: target,
              bytes,
            });
            differences.push(target);
          }
        }
      }
    }
    if (!check) {
      for (const entry of deletes) {
        files.remove(entry.path);
        removed.push(entry.path);
        removeEmptyParents(root, entry.path, entry.folder);
      }
      for (const entry of [...writes, ...ownershipWrites]) {
        files.write(entry.path, entry.bytes);
        written.push(entry.path);
      }
    }
  } catch (error) {
    refuse(
      "INPUT_INVALID",
      error instanceof Error ? error.message : "Cannot write skills",
    );
  }
  return {
    dir: dirs.join(", "),
    written,
    unchanged,
    skipped,
    removed,
    differences,
    readErrors,
  };
}
