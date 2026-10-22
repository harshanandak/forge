// Whole-document checks and encoding for a planned project config. Every edit is validated as a
// whole before anything is written: the forge.config/1 schema (unknown keys are refused there) and,
// where the catalog supplies it, each instance's own configSchema against its resolved config.
import { ForgeFailure } from "../../contract/failure.ts";
import {
  jsonEqual,
  type JsonSchema,
  type SchemaProblem,
  validateWithSchema,
} from "../../contract/schema.ts";
import type {
  BlockSource,
  ForgeError,
  ParseLimits,
} from "../../generated/types.ts";
import { DEFAULT_PARSE_LIMITS } from "../../contract/untrusted.ts";
import {
  validateBlockSource,
  validateConfigDocument,
} from "../../generated/validators.ts";
import type {
  ConfigCodecPort,
  ConfigTextEdit,
} from "../../ports/config-codec.ts";
import { atomicSource } from "./layers.ts";
import {
  formatPointer,
  isObject,
  type JsonObject,
  leaves,
  parsePointer,
} from "./pointer.ts";
import { absoluteUses, expandShortForm } from "./short.ts";
import { CONFIG_FILE } from "./store.ts";

export const CONFIG_VERSION = "forge.config/1";

/** Hooks the assembly supplies from the catalog; both are optional. */
export interface BlockLookup {
  /** The source of an instance name people configure without adding it first (a builtin block's own name). */
  readonly builtinSource?: (instance: string) => BlockSource | undefined;
  /**
   * A block's configSchema, from the block already captured for this call: its property defaults
   * are the lowest config layer, and edits check the resolved config with it.
   */
  readonly blockConfig?: (
    instance: string,
    source: BlockSource,
  ) => BlockConfigSchema | undefined;
}

export interface BlockConfigSchema {
  /** The object schema, after any top-level `$ref`; its properties' `default`s are read. */
  readonly schema: JsonSchema;
  /** Problems with a resolved config, pointers relative to the config. */
  check(config: unknown): readonly SchemaProblem[];
}

/** A config schema that is one standalone document (no `$ref` to other files). */
export function standaloneConfigSchema(schema: JsonSchema): BlockConfigSchema {
  return { schema, check: (config) => validateWithSchema(schema, config) };
}

export function emptyDocument(): JsonObject {
  return { schemaVersion: CONFIG_VERSION, blocks: {} };
}

/** True when the document configures nothing, so the project is back to the adaptive layer. */
export function configuresNothing(document: JsonObject): boolean {
  const blocks = isObject(document.blocks) ? document.blocks : {};
  return Object.keys(document).every(
    (key) =>
      key === "schemaVersion" ||
      (key === "blocks" && Object.keys(blocks).length === 0) ||
      (key === "owners" &&
        isObject(document.owners) &&
        Object.keys(document.owners).length === 0) ||
      (key === "templates" &&
        Array.isArray(document.templates) &&
        document.templates.length === 0),
  );
}

/** Give each instance that has keys but no source the builtin source of the same name, if there is one. */
export function fillSources(
  document: JsonObject,
  lookup: BlockLookup,
): string[] {
  const filled: string[] = [];
  const blocks = isObject(document.blocks) ? document.blocks : {};
  for (const [name, instance] of Object.entries(blocks)) {
    if (!isObject(instance) || Object.hasOwn(instance, "source")) continue;
    const source = lookup.builtinSource?.(name);
    if (source === undefined || !validateBlockSource(source).ok) continue;
    instance.source = source;
    filled.push(formatPointer(["blocks", name, "source"]));
  }
  return filled;
}

function invalid(
  problems: ReadonlyArray<{ pointer: string; message: string }>,
): ForgeFailure {
  const [first] = problems;
  const error: ForgeError = {
    code: "INPUT_INVALID",
    message:
      `the planned ${CONFIG_FILE} is not valid: ${first?.pointer || "/"} ${first?.message ?? ""}`.trim(),
    retry: "never",
    observed: problems.slice(0, 16),
    ...(first?.pointer === undefined || first.pointer === ""
      ? {}
      : { pointer: first.pointer }),
  };
  return new ForgeFailure(error);
}

/** The forge.config/1 checks; each instance's own config is checked resolved, in config.ts. */
export function checkDocument(document: JsonObject): void {
  const uses = absoluteUses(document);
  if (uses.length > 0) throw invalid(uses);
  const checked = validateConfigDocument(document);
  if (!checked.ok) {
    const missingSource = checked.problems.find(
      (p) =>
        p.keyword === "required" && /^\/blocks\/[^/]+\/source$/.test(p.pointer),
    );
    if (missingSource !== undefined) {
      const name = (parsePointer(missingSource.pointer) ?? [])[1] ?? "";
      throw new ForgeFailure({
        code: "INPUT_INVALID",
        message: `blocks.${name} has no source, and no installed block is named "${name}"`,
        pointer: missingSource.pointer,
        retry: "never",
        repair: `say where the block comes from in the same edit: set /blocks/${name}/source to {"builtin": "<publisher>/<name>"}, {"path": "<dir>"} or {"package": "<name>"}`,
      });
    }
    throw invalid(checked.problems);
  }
}

/** Refuse an instance whose resolved config does not match its block's configSchema. */
export function checkInstanceConfig(
  name: string,
  problems: readonly SchemaProblem[],
): void {
  // A required key with no default that nothing sets: say so plainly, with where it can come from.
  const missing = problems.find(
    (p) => p.keyword === "required" && /^\/[^/]+$/.test(p.pointer),
  );
  if (missing !== undefined) {
    const key = parsePointer(missing.pointer)?.[0] ?? "";
    const pointer = formatPointer(["blocks", name, "config", key]);
    throw new ForgeFailure({
      code: "INPUT_INVALID",
      message: `blocks.${name} needs ${key}, and nothing sets it: ${CONFIG_FILE} has no value and nothing was detected in this project`,
      pointer,
      retry: "never",
      repair: `set ${pointer} in the same edit`,
    });
  }
  if (problems.length > 0) {
    throw invalid(
      problems.map((p) => ({
        pointer: `${formatPointer(["blocks", name, "config"])}${p.pointer}`,
        message: p.message,
      })),
    );
  }
}

/** The file bytes for a document, or null to remove the file because nothing is configured. */
export function encodeDocument(
  document: JsonObject,
  codec: ConfigCodecPort,
  original?: string,
  before: JsonObject = emptyDocument(),
  warn?: (message: string) => void,
  limits: ParseLimits = DEFAULT_PARSE_LIMITS,
): Uint8Array | null {
  if (original !== undefined && jsonEqual(before, document))
    return new TextEncoder().encode(original);
  if (configuresNothing(document)) return null;
  const valid = (text: string): boolean => {
    const parsed = codec.decode(text, limits);
    return (
      parsed.ok &&
      isObject(parsed.value) &&
      jsonEqual(expandShortForm(parsed.value), document)
    );
  };
  let text: string | undefined;
  let lost = false;
  if (original !== undefined && codec.edit) {
    const raw = codec.decode(original, limits);
    const edits: ConfigTextEdit[] = [];
    const walk = (a: unknown, b: unknown, path: (string | number)[]) => {
      if (jsonEqual(a, b)) return;
      if (
        raw.ok &&
        isObject(raw.value) &&
        path[0] === "blocks" &&
        path[2] === "config" &&
        path.length === 4
      ) {
        const blocks = raw.value.blocks;
        const instance = isObject(blocks) ? blocks[String(path[1])] : undefined;
        if (isObject(instance) && Object.hasOwn(instance, String(path[3])))
          edits.push({ path, from: [...path.slice(0, 2), path[3]!], value: a });
      }
      if (
        (isObject(a) && isObject(b) && !atomicSource(path.map(String))) ||
        (Array.isArray(a) && Array.isArray(b) && a.length === b.length)
      ) {
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
          walk(
            (a as Record<string, unknown>)[key],
            (b as Record<string, unknown>)[key],
            [...path, Array.isArray(a) ? Number(key) : key],
          );
        return;
      }
      let from: (string | number)[] | undefined;
      if (raw.ok && isObject(raw.value) && path[0] === "blocks") {
        const blocks = raw.value.blocks;
        const instance = isObject(blocks) ? blocks[String(path[1])] : undefined;
        if (isObject(instance)) {
          if (path[2] === "source" && Object.hasOwn(instance, "use"))
            from = path.slice(0, 2).concat("use");
        }
      }
      edits.push({
        path,
        ...(from ? { from } : {}),
        ...(b === undefined ? {} : { value: b }),
      });
    };
    walk(before, document, []);
    try {
      const edited = codec.edit(original, edits);
      lost = edited.formattingLost;
      if (valid(edited.text)) text = edited.text;
    } catch {
      /* A codec edit failure uses the validated serializer below. */
    }
  }
  if (text === undefined) {
    text = codec.encode(document);
    if (!valid(text))
      throw new ForgeFailure({
        code: "INPUT_INVALID",
        message: "encoded config differs from the plan or exceeds parse limits",
        retry: "never",
      });
    lost = original !== undefined;
  }
  if (lost) warn?.(`${CONFIG_FILE}: formatting could not be preserved`);
  return new TextEncoder().encode(text);
}

export interface Change {
  readonly pointer: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

/** Key-by-key difference between two documents. */
export function diff(
  before: JsonObject | undefined,
  after: JsonObject | undefined,
): Change[] {
  const map = (doc: JsonObject | undefined): Map<string, unknown> =>
    new Map(
      doc === undefined
        ? []
        : leaves(doc, atomicSource)
            .filter((l) => l.segments[0] !== "schemaVersion")
            .map((l) => [formatPointer(l.segments), l.value]),
    );
  const a = map(before);
  const b = map(after);
  const changes: Change[] = [];
  for (const pointer of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const was = a.get(pointer);
    const now = b.get(pointer);
    if (!a.has(pointer)) changes.push({ pointer, after: now });
    else if (!b.has(pointer)) changes.push({ pointer, before: was });
    else if (!jsonEqual(was, now)) {
      changes.push({ pointer, before: was, after: now });
    }
  }
  return changes;
}
