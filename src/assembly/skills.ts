import {
  entryKind,
  nodeConfigFiles,
  removeEmptyParents,
} from "../adapters/fs/index.ts";
import type { McpCandidate } from "../contract/mcp.ts";
import { ForgeFailure } from "../contract/failure.ts";
import type { ConfigFiles } from "../core/config/files.ts";
import { refuse } from "../core/trust/index.ts";
import {
  GENERATED_MARKER,
  SKILL_MAX_BYTES,
  lintReference,
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
  readonly errors: readonly {
    readonly op: "read" | "write" | "remove";
    readonly path: string;
    readonly message: string;
  }[];
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
  files: Pick<ConfigFiles, "read">,
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

function accessFailure(error: unknown): boolean {
  if (error instanceof ForgeFailure)
    return error.error.code === "LIMIT_EXCEEDED";
  return (
    typeof error === "object" &&
    error !== null &&
    ("code" in error || ("cause" in error && accessFailure(error.cause)))
  );
}

function checkCompanionPath(path: string, origin: string): readonly string[] {
  const parts = path.split("/");
  if (
    /[\\:,\r\n]/.test(path) ||
    path !== path.trim() ||
    parts.some((part) => ["", ".", ".."].includes(part)) ||
    key(path) === key("SKILL.md")
  )
    throw new Error(`Invalid companion path ${path} in ${origin}`);
  return parts;
}

function validate(
  inspect: (path: string) => ReturnType<typeof entryKind>,
  path: string,
  origin: string,
): boolean {
  const parts = checkCompanionPath(path, origin);
  // Probe every component as a final component, so even an internal link is refused.
  try {
    for (let i = 1; i <= parts.length; i++) {
      const kind = inspect(parts.slice(0, i).join("/"));
      if (kind === "link") throw new Error("symlinked path is not followed");
      if (i < parts.length && kind !== "missing" && kind !== "directory")
        return false;
    }
    return true;
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
type SkillSourceFiles = Pick<ConfigFiles, "list" | "read">;
type SkillCatalogBudget = { bytes: number; entries: number };

export const SKILL_CATALOG_MAX_BYTES = 1_048_576;
export const SKILL_CATALOG_MAX_ENTRIES = 512;

export interface RenderedSkillFile {
  readonly noun: string;
  readonly path: string;
  readonly bytes: Uint8Array;
}

const EMPTY_TEMPLATES: TemplateSkills = { sources: [], values: undefined };

function skillBytes(copy: Copy, adopted: readonly string[]): Uint8Array {
  return (
    copy.bytes ??
    new TextEncoder().encode(
      copy.text.replace(
        GENERATED_MARKER,
        `${GENERATED_MARKER}${adopted.length ? `\n${companionLine(adopted)}` : ""}`,
      ),
    )
  );
}

function tree(
  files: SkillSourceFiles,
  dir: string,
  primary: string,
): { path: string; bytes: Uint8Array }[] {
  readFile(files, dir);
  return files.list(dir).flatMap((name) => {
    const path = `${dir}/${name}`;
    if (key(path) === key(primary)) return [];
    const bytes = readFile(files, path);
    if (bytes === undefined) return tree(files, path, primary);
    return [{ path, bytes }];
  });
}

function skillSourceFiles(
  root: string,
  budget?: SkillCatalogBudget,
): SkillSourceFiles {
  if (budget === undefined) return nodeConfigFiles(root);
  const files = nodeConfigFiles(root, { strict: true });
  return {
    list(dir) {
      const entries = files.list(dir, budget.entries);
      budget.entries -= entries.length;
      const privateName = /^(?:\.|id_(?:rsa|dsa|ecdsa|ed25519)$)|\.pem$/i;
      if (entries.some((name) => privateName.test(name)))
        refuse("INPUT_INVALID", "Private file name in template skill catalog");
      return entries;
    },
    read(path) {
      if (entryKind(root, path, true) === "directory") return undefined;
      const bytes = files.read(path, budget.bytes);
      if (bytes === undefined) return undefined;
      budget.bytes -= bytes.byteLength;
      return bytes;
    },
  };
}

/** Each template's `skills/<name>/SKILL.md`, read from next to the template file and rendered. */
function templateSkills(
  templates: TemplateSkills,
  budget?: SkillCatalogBudget,
): Copy[] {
  const skills: Copy[] = [];
  for (const source of templates.sources) {
    if (budget !== undefined) {
      if (budget.entries === 0)
        refuse("LIMIT_EXCEEDED", "Skill catalog entry limit exceeded");
      budget.entries--;
    }
    const files = skillSourceFiles(source.root, budget);
    const parent = source.file.split("/").slice(0, -1).join("/");
    const dir = parent === "" ? "skills" : `${parent}/skills`;
    for (const name of files.list(dir)) {
      const entry = `${dir}/${name}`;
      const kind = entryKind(source.root, entry, budget !== undefined);
      if (kind === "file") continue;
      if (kind !== "directory")
        refuse(
          "INPUT_INVALID",
          `Invalid template skill folder ${entry}: expected directory, found ${kind}`,
        );
      const path = `${entry}/SKILL.md`;
      let bytes: Uint8Array | undefined;
      try {
        bytes = files.read(path);
      } catch (error) {
        refuse(
          "INPUT_INVALID",
          `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (bytes === undefined) continue;
      const rendered = renderTemplateSkill(
        name,
        new TextDecoder().decode(bytes),
        templates.values,
        budget === undefined ? undefined : SKILL_MAX_BYTES,
      );
      if ("unknown" in rendered)
        refuse(
          "INPUT_INVALID",
          `${dir}/${name}/SKILL.md uses unknown values: ${rendered.unknown.join(", ")}`,
        );
      const extras = tree(files, entry, path);
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
 * the project root. Readable marked files are replaced, or deleted once no longer produced.
 * Oversized files follow the same left-alone path as unmarked user files.
 */
export function syncSkills(
  root: string,
  candidates: readonly McpCandidate[],
  prefix: string | undefined,
  requested: string | readonly string[] = DEFAULT_SKILLS_DIR,
  templates: TemplateSkills = EMPTY_TEMPLATES,
  check = false,
): SkillsSyncResult {
  const files = nodeConfigFiles(root);
  let dirs: string[];
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
  } catch (error) {
    refuse(
      "INPUT_INVALID",
      error instanceof Error ? error.message : "Cannot read template skills",
    );
  }
  const skills = collectSkills(candidates, prefix, templates);
  const written: string[] = [];
  const unchanged: string[] = [];
  const skipped: string[] = [];
  const removed: string[] = [];
  const differences: string[] = [];
  const errors: {
    op: "read" | "write" | "remove";
    path: string;
    message: string;
  }[] = [];
  const report = (
    op: "read" | "write" | "remove",
    path: string,
    error: unknown,
  ): void => {
    errors.push({
      op,
      path,
      message: error instanceof Error ? error.message : String(error),
    });
  };
  try {
    const writes: { path: string; bytes: Uint8Array; folder: string }[] = [];
    const ownershipWrites: typeof writes = [];
    const deletes: { path: string; folder: string; expected: Uint8Array }[] =
      [];
    // Plan every directory first. Invalid metadata must not leave a partial sync.
    for (const dir of dirs) {
      const names = new Map(
        [...files.list(dir), ...skills.map((s) => s.noun)].map((name) => [
          key(name),
          name,
        ]),
      );
      let accessed = dir;
      const plan = (name: string): void => {
        const folder = `${dir}/${name}`;
        accessed = folder;
        const copies = skills.filter((s) => key(s.noun) === key(name));
        const kind = entryKind(root, folder);
        if (kind !== "directory" && kind !== "missing") {
          if (copies.length) skipped.push(folder);
          return;
        }
        const localRoot = `${root}/${folder}`;
        const base = nodeConfigFiles(localRoot);
        const local = {
          ...base,
          read(relative: string, maxBytes?: number) {
            accessed = `${folder}/${relative}`;
            return base.read(relative, maxBytes);
          },
        };
        const inspect = (relative: string): ReturnType<typeof entryKind> => {
          accessed = `${folder}/${relative}`;
          return entryKind(localRoot, relative);
        };
        const path = `${folder}/SKILL.md`;
        const skillKind = inspect("SKILL.md");
        const current =
          skillKind === "file" ? local.read("SKILL.md") : undefined;
        const listed = companions(current, path);
        if (listed === undefined && skillKind !== "missing") {
          if (copies.length) skipped.push(path);
          for (const copy of copies.filter(
            (s) => s.bytes === undefined && s.path.endsWith("/reference.md"),
          ))
            skipped.push(`${dir}/${copy.path}`);
          return;
        }
        const markedReference =
          (!copies.length ||
            copies.some(
              (copy) =>
                copy.bytes === undefined && copy.path.endsWith("/reference.md"),
            )) &&
          inspect("reference.md") === "file" &&
          lines(local.read("reference.md")!).includes(GENERATED_MARKER);
        for (const entry of listed ?? []) validate(inspect, entry, path);
        const wanted = new Map(
          copies.map((s) => [key(s.path.slice(s.noun.length + 1)), s]),
        );
        const adopted: string[] = [];
        for (const [relative, copy] of wanted) {
          if (relative === key("SKILL.md")) continue;
          if (relative === "reference.md" && copy.bytes === undefined) continue;
          const destination = copy.path.slice(copy.noun.length + 1);
          const clear = validate(inspect, destination, path);
          const bytes = copy.bytes!;
          const displaced = (listed ?? []).some(
            (p) =>
              !wanted.has(key(p)) &&
              key(destination).startsWith(`${key(p)}/`) &&
              inspect(p) === "file",
          );
          if (
            !displaced &&
            (!clear || !["missing", "file"].includes(inspect(destination)))
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
        for (const relative of new Set([
          ...(listed ?? []),
          ...(markedReference ? ["reference.md"] : []),
        ])) {
          if (wanted.has(key(relative))) continue;
          const target = `${folder}/${relative}`;
          const held = readFile(local, relative);
          if (held !== undefined) {
            deletes.push({ path: target, folder, expected: held });
            differences.push(target);
          }
        }
        if (!copies.length) {
          if (listed !== undefined) {
            deletes.push({ path, folder, expected: current! });
            differences.push(path);
          }
          return;
        }
        for (const copy of copies) {
          const relative = copy.path.slice(copy.noun.length + 1);
          if (
            copy.bytes === undefined &&
            relative === "reference.md" &&
            inspect(relative) !== "missing" &&
            !markedReference
          ) {
            skipped.push(`${folder}/${relative}`);
            continue;
          }
          if (copy.bytes !== undefined && !adopted.includes(relative)) continue;
          const bytes = skillBytes(copy, adopted);
          const target = `${folder}/${relative}`;
          const existing = readFile(local, relative);
          if (existing !== undefined && equal(existing, bytes))
            unchanged.push(target);
          else {
            (copy.bytes === undefined ? ownershipWrites : writes).push({
              path: target,
              bytes,
              folder,
            });
            differences.push(target);
          }
        }
      };
      for (const name of names.values()) {
        const lists = [
          writes,
          ownershipWrites,
          deletes,
          unchanged,
          skipped,
          differences,
        ];
        const lengths = lists.map((list) => list.length);
        try {
          plan(name);
        } catch (error) {
          if (!accessFailure(error)) throw error;
          lists.forEach((list, i) => {
            list.length = lengths[i]!;
          });
          if (
            error instanceof ForgeFailure &&
            error.error.code === "LIMIT_EXCEEDED" &&
            accessed === `${dir}/${name}/SKILL.md`
          ) {
            if (skills.some((skill) => key(skill.noun) === key(name)))
              skipped.push(accessed);
          } else report("read", accessed, error);
        }
      }
    }
    if (!check) {
      const folders = new Set(
        [...deletes, ...writes, ...ownershipWrites].map(
          (entry) => entry.folder,
        ),
      );
      for (const folder of folders) {
        let operation: "write" | "remove" = "remove";
        let path = `${folder}/SKILL.md`;
        try {
          for (const entry of deletes.filter(
            (entry) => entry.folder === folder,
          )) {
            path = entry.path;
            files.remove(entry.path, entry.expected);
            removed.push(entry.path);
            path = entry.path.split("/").slice(0, -1).join("/");
            removeEmptyParents(root, entry.path, entry.folder);
          }
          operation = "write";
          for (const entry of [...writes, ...ownershipWrites].filter(
            (entry) => entry.folder === folder,
          )) {
            path = entry.path;
            files.write(entry.path, entry.bytes);
            written.push(entry.path);
          }
        } catch (error) {
          report(
            operation,
            typeof error === "object" &&
              error !== null &&
              "relativePath" in error &&
              typeof error.relativePath === "string"
              ? error.relativePath
              : path,
            error,
          );
        }
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
    errors,
  };
}

function collectSkills(
  candidates: readonly McpCandidate[],
  prefix: string | undefined,
  templates: TemplateSkills,
  budget?: SkillCatalogBudget,
): Copy[] {
  let skills: Copy[];
  try {
    skills = [
      ...renderSkills(candidates, prefix),
      ...templateSkills(templates, budget),
    ];
  } catch (error) {
    refuse(
      "INPUT_INVALID",
      error instanceof Error ? error.message : "Cannot read template skills",
    );
  }
  const problems = skills.flatMap((skill) => {
    const issues =
      skill.bytes === undefined
        ? (skill.path.endsWith("/SKILL.md") ? lintSkill : lintReference)(
            skill.text,
            candidates,
            prefix,
          )
        : /\.md$/i.test(skill.path)
          ? lintReference(
              new TextDecoder().decode(skill.bytes),
              candidates,
              prefix,
            )
          : [];
    return issues.map((problem) => `${skill.path}: ${problem}`);
  });
  const paths = skills.map((skill) => skill.path);
  for (const [index, path] of paths.entries())
    if (paths.findIndex((other) => key(other) === key(path)) !== index)
      problems.push(`${path}: produced by more than one source`);
  if (problems.length > 0)
    refuse(
      "OUTPUT_INVALID",
      `Generated skills fail the lint: ${problems.join("; ")}`,
    );
  return skills;
}

export function renderSkillCatalog(
  candidates: readonly McpCandidate[],
  prefix?: string,
  templates: TemplateSkills = EMPTY_TEMPLATES,
): readonly RenderedSkillFile[] {
  const skills = collectSkills(candidates, prefix, templates, {
    bytes: SKILL_CATALOG_MAX_BYTES,
    entries: SKILL_CATALOG_MAX_ENTRIES,
  });
  if (skills.length > SKILL_CATALOG_MAX_ENTRIES)
    refuse(
      "LIMIT_EXCEEDED",
      `Skill catalog exceeds ${SKILL_CATALOG_MAX_ENTRIES} files`,
    );
  const pathsByNoun = new Map<string, string[]>();
  for (const copy of skills) {
    if (copy.bytes === undefined) continue;
    const relative = copy.path.slice(copy.noun.length + 1);
    checkCompanionPath(relative, `${copy.noun}/SKILL.md`);
    const paths = pathsByNoun.get(copy.noun) ?? [];
    paths.push(relative);
    pathsByNoun.set(copy.noun, paths);
  }
  const rendered = skills.map((copy) => ({
    noun: copy.noun,
    path: copy.path,
    bytes: skillBytes(copy, pathsByNoun.get(copy.noun) ?? []),
  }));
  const size = rendered.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (size > SKILL_CATALOG_MAX_BYTES)
    refuse(
      "LIMIT_EXCEEDED",
      `Skill catalog exceeds ${SKILL_CATALOG_MAX_BYTES} bytes`,
    );
  return rendered;
}
