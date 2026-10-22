// The one naming convention. Segments are kebab-case and keys lowerCamel; the separator names the
// surface: `.` in a Forge name, `_` on MCP, a space on the CLI, `/` after the publisher, `:` before
// an event's local name, `@` before a version, `#` before the verb in a permission key. Segments
// never contain `.` or `_`, so every mapping is bijective.
import type { ForgeError } from "../generated/types.ts";
import {
  validateBlockId,
  validateMcpToolName,
  validateNoun,
  validateOperationName,
  validatePropertyName,
  validatePublisher,
} from "../generated/validators.ts";

/** Nouns core owns. */
export const CORE_NOUNS: readonly string[] = [
  "block",
  "catalog",
  "config",
  "doctor",
  "host",
  "skills",
  "state",
  "store",
  "template",
];

/** Nouns the generated surfaces reserve for themselves. */
export const SURFACE_NOUNS: readonly string[] = [
  "completion",
  "forge",
  "help",
  "hook",
  "mcp",
  "version",
  "x",
];

/** The catalog tools MCP always lists, whatever the budget. */
export const CATALOG_TOOL_NAMES: readonly string[] = [
  "catalog_list",
  "catalog_describe",
  "catalog_call",
];

/** Global CLI flags no operation property may map to. */
export const RESERVED_FLAGS: readonly string[] = [
  "text",
  "json",
  "hook",
  "mcp",
  "dry-run",
  "format",
  "help",
  "input",
  "project",
  "quiet",
  "request-id",
  "version",
];

export interface ParsedOperation {
  readonly noun: string;
  readonly verb: string;
}

export function parseOperationName(op: string): ParsedOperation | undefined {
  if (!validateOperationName(op).ok) return undefined;
  const [noun = "", verb = ""] = op.split(".");
  return { noun, verb };
}

export interface ParsedBlockId {
  readonly publisher: string;
  readonly name: string;
}

export function parseBlockId(id: string): ParsedBlockId | undefined {
  if (!validateBlockId(id).ok) return undefined;
  const slash = id.indexOf("/");
  return { publisher: id.slice(0, slash), name: id.slice(slash + 1) };
}

/** `forge`, `forge.*` and any publisher whose second label is `forge` are reserved for first-party blocks. */
export function isReservedPublisher(publisher: string): boolean {
  const labels = publisher.split(".");
  return labels[0] === "forge" || labels[1] === "forge";
}

/** MCP tool name for an operation: `noun_verb`, optionally behind a configured prefix. */
export function mcpToolName(op: string, prefix?: string): string | undefined {
  const parsed = parseOperationName(op);
  if (parsed === undefined) return undefined;
  const base = `${parsed.noun}_${parsed.verb}`;
  if (!validateMcpToolName(base).ok) return undefined;
  const name = prefix === undefined ? base : `${prefix}_${base}`;
  return name.length <= 64 ? name : undefined;
}

/** The operation an MCP tool name projects, or undefined when it is not a projected name. */
export function operationFromMcpToolName(
  name: string,
  prefix?: string,
): string | undefined {
  let base = name;
  if (prefix !== undefined) {
    if (!name.startsWith(`${prefix}_`)) return undefined;
    base = name.slice(prefix.length + 1);
  }
  if (!validateMcpToolName(base).ok) return undefined;
  return base.replace("_", ".");
}

/** CLI words for an operation: `forge <noun> <verb>`. */
export function cliWords(op: string): readonly [string, string] | undefined {
  const parsed = parseOperationName(op);
  return parsed === undefined ? undefined : [parsed.noun, parsed.verb];
}

/** The CLI flag for an input property: `preRelease` maps to `pre-release`. */
export function flagName(property: string): string | undefined {
  if (!validatePropertyName(property).ok) return undefined;
  return property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** The input property a CLI flag maps back to: `pre-release` maps to `preRelease`. */
export function propertyFromFlag(flag: string): string | undefined {
  const property = flag.replace(/-([a-z0-9])/g, (_m, c: string) =>
    c.toUpperCase(),
  );
  return flagName(property) === flag ? property : undefined;
}

/** `<blockId>.<noun>@<interface version>#<verb>`; renames never change it. */
export function permissionKey(
  blockId: string,
  noun: string,
  interfaceVersion: string,
  verb: string,
): string {
  return `${blockId}.${noun}@${interfaceVersion}#${verb}`;
}

/** `<blockId>:<noun>.<past-participle>@<major>`. */
export function eventType(
  blockId: string,
  noun: string,
  pastParticiple: string,
  major: number,
): string {
  return `${blockId}:${noun}.${pastParticiple}@${major}`;
}

export interface NounRules {
  /** Nouns of first-party blocks, reserved even when those blocks are not installed. */
  readonly firstPartyNouns: Iterable<string>;
}

/** Why a noun may not be declared by a block from this publisher, or undefined when it may. */
export function nounRefusal(
  noun: string,
  publisher: string,
  rules: NounRules,
): ForgeError | undefined {
  if (!validateNoun(noun).ok || !validatePublisher(publisher).ok) {
    return {
      code: "INPUT_INVALID",
      message: `the noun "${noun}" or the publisher "${publisher}" does not follow the naming grammar`,
      retry: "never",
    };
  }
  if (isReservedPublisher(publisher)) return undefined;
  const reserved = new Set([
    ...CORE_NOUNS,
    ...SURFACE_NOUNS,
    ...rules.firstPartyNouns,
  ]);
  if (reserved.has(noun) || noun.startsWith("forge-")) {
    return {
      code: "NAME_RESERVED",
      message: `the noun "${noun}" is reserved`,
      retry: "never",
      repair: `pick another noun, or map it locally with rename: { ${noun}: <new-noun> }`,
    };
  }
  return undefined;
}

/**
 * Nouns that collide: the same noun twice, or one noun equal to another plus `-…`, so suggestions
 * and completion stay unambiguous. Install order never decides; both sides are reported.
 */
export function nounCollisions(nouns: readonly string[]): readonly string[][] {
  const collisions: string[][] = [];
  const sorted = [...nouns].sort();
  for (const [index, noun] of sorted.entries()) {
    for (const other of sorted.slice(index + 1)) {
      if (other === noun || other.startsWith(`${noun}-`)) {
        collisions.push([noun, other]);
      }
    }
  }
  return collisions;
}
