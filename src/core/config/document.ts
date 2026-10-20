// Whole-document checks and encoding for a planned project config. Every edit is validated as a
// whole before anything is written: the forge.config/1 schema (unknown keys are refused there) and,
// where the catalog supplies it, each instance's own configSchema.
import { ForgeFailure } from "../../contract/failure.ts";
import {
  jsonEqual,
  type JsonSchema,
  validateWithSchema,
} from "../../contract/schema.ts";
import type { BlockSource, ForgeError } from "../../generated/types.ts";
import {
  validateBlockSource,
  validateConfigDocument,
} from "../../generated/validators.ts";
import type { ConfigCodecPort } from "../../ports/config-codec.ts";
import { atomicSource } from "./layers.ts";
import {
  formatPointer,
  isObject,
  type JsonObject,
  leaves,
  parsePointer,
} from "./pointer.ts";
import { withDefaults } from "./short.ts";
import { CONFIG_FILE } from "./store.ts";

export const CONFIG_VERSION = "forge.config/1";

/** Hooks the assembly supplies from the catalog; both are optional. */
export interface BlockLookup {
  /** The source of an instance name people configure without adding it first (a builtin block's own name). */
  readonly builtinSource?: (instance: string) => BlockSource | undefined;
  /** A block's configSchema, so unknown keys inside an instance's config are refused too. */
  readonly configSchema?: (
    instance: string,
    source: BlockSource,
  ) => JsonSchema | undefined;
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

export function checkDocument(document: JsonObject, lookup: BlockLookup): void {
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
  const blocks = checked.value.blocks;
  for (const [name, instance] of Object.entries(blocks)) {
    const schema = lookup.configSchema?.(name, instance.source);
    if (schema === undefined) continue;
    const problems = validateWithSchema(
      schema,
      withDefaults(schema, instance.config ?? {}),
    );
    if (problems.length > 0) {
      throw invalid(
        problems.map((p) => ({
          pointer: `${formatPointer(["blocks", name, "config"])}${p.pointer}`,
          message: p.message,
        })),
      );
    }
  }
}

/** The file bytes for a document, or null to remove the file because nothing is configured. */
export function encodeDocument(
  document: JsonObject,
  codec: ConfigCodecPort,
): Uint8Array | null {
  if (configuresNothing(document)) return null;
  return new TextEncoder().encode(codec.encode(document));
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
