// laws.check: a read-only report of which laws the project states and whether the config backs
// each one. A law names resolved config values that must hold at a named point. It is `enforced`
// when an enabled, loadable block declares that point, every value sits inside what that block
// enforces and every condition holds; `broken` when a condition fails; `unenforced` when no block
// enforces the point or the values lie outside what it enforces. Values come from the one resolver
// (config.show and config.explain); this module never layers or writes anything.
import { jsonEqual } from "../../contract/schema.ts";
import type { ConfigApi, ValueSource } from "./config.ts";
import {
  formatPointer,
  isObject,
  isPrefix,
  type JsonObject,
  parsePointer,
  toPointer,
} from "./pointer.ts";

/**
 * What one enabled, loadable block says it enforces: a named point, and the part of its own config
 * that enforcement reads. The host builds this list from the composed blocks; core names no point.
 */
export interface Enforcer {
  readonly point: string;
  /** The block instance that enforces it, for the report. */
  readonly instance: string;
  /** Config pointer segments that enforcement reads; a law counts as enforced only inside one. */
  readonly root: readonly string[];
  /** Whether the block reads the setting at these pointer segments (the whole pointer from the document root). */
  readonly reads: (segments: readonly string[]) => boolean;
}

/**
 * Whether a config schema declares the setting at these segments: each segment is a declared
 * property, an array index into `items`, or a key an `additionalProperties` schema admits. A
 * free-form object (no `properties`, no combinator) or an empty schema admits any key. A block ignores settings its
 * schema does not declare, so a law on one of those is not enforced by that block.
 */
export function schemaDeclares(
  schema: unknown,
  segments: readonly string[],
): boolean {
  if (segments.length === 0 || schema === true) return true;
  if (!isObject(schema)) return false;
  const [head, ...rest] = segments as [string, ...string[]];
  const alternatives = ["oneOf", "anyOf", "allOf"].flatMap((key) => {
    const found = schema[key];
    return Array.isArray(found) ? found : [];
  });
  if (alternatives.some((alt) => schemaDeclares(alt, segments))) return true;
  const { properties, items, additionalProperties } = schema;
  if (isObject(properties) && Object.hasOwn(properties, head))
    return schemaDeclares(properties[head], rest);
  if (items !== undefined && /^d+$/.test(head))
    return schemaDeclares(items, rest);
  if (additionalProperties === true) return true;
  if (isObject(additionalProperties))
    return schemaDeclares(additionalProperties, rest);
  // a free-form object, or a schema that says nothing, admits any key
  return (
    (schema.type === "object" || Object.keys(schema).length === 0) &&
    properties === undefined &&
    additionalProperties === undefined &&
    alternatives.length === 0
  );
}

export type LawStatus = "enforced" | "broken" | "unenforced";

export interface LawReason {
  readonly pointer: string;
  readonly condition: JsonObject;
  readonly actual: unknown;
  readonly set: boolean;
  readonly holds: boolean;
  readonly source: ValueSource | null;
}

export interface LawReport {
  readonly id: string;
  readonly says: string;
  readonly at: string;
  readonly status: LawStatus;
  readonly detail: string;
  readonly reasons: readonly LawReason[];
}

export interface LawsReport {
  readonly verdict: "PASS" | "FAIL" | "INCOMPLETE";
  readonly laws: readonly LawReport[];
  readonly summary: Readonly<Record<LawStatus, number>>;
  readonly problems: readonly string[];
}

export interface LawsApi {
  check(): LawsReport;
}

function summarize(
  problems: readonly string[],
  laws: readonly LawReport[],
): LawsReport {
  const summary = { enforced: 0, broken: 0, unenforced: 0 };
  for (const law of laws) summary[law.status] += 1;
  return {
    verdict:
      problems.length > 0 || summary.broken > 0
        ? "FAIL"
        : summary.unenforced > 0
          ? "INCOMPLETE"
          : "PASS",
    laws,
    summary,
    problems,
  };
}

function filled(value: unknown): boolean {
  if (typeof value === "string" || Array.isArray(value))
    return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return value !== null && value !== undefined;
}

/** One condition against one resolved value. A value that is not set fails every condition. */
function holds(condition: JsonObject, set: boolean, actual: unknown): boolean {
  if (!set) return false;
  const [kind] = Object.keys(condition);
  const expected = kind === undefined ? undefined : condition[kind];
  switch (kind) {
    case "equals":
      return jsonEqual(actual, expected);
    case "contains":
      return Array.isArray(actual)
        ? actual.some((item) => jsonEqual(item, expected))
        : typeof actual === "string" &&
            typeof expected === "string" &&
            actual.includes(expected);
    case "nonEmpty":
      return filled(actual) === (expected === true);
    case "atLeast":
      return (
        typeof actual === "number" &&
        typeof expected === "number" &&
        actual >= expected
      );
    case "atMost":
      return (
        typeof actual === "number" &&
        typeof expected === "number" &&
        actual <= expected
      );
    default:
      return false;
  }
}

export function createLaws(
  config: Pick<ConfigApi, "show" | "explain">,
  enforcers: () => readonly Enforcer[] = () => [],
): LawsApi {
  const reasonFor = (path: string, condition: JsonObject): LawReason => {
    const segments = toPointer(path);
    if (segments === undefined)
      return {
        pointer: path,
        condition,
        actual: null,
        set: false,
        holds: false,
        source: null,
      };
    const found = config.explain({ path: formatPointer(segments) });
    return {
      pointer: found.pointer,
      condition,
      actual: found.set ? found.value : null,
      set: found.set,
      holds: holds(condition, found.set, found.value),
      source: found.source,
    };
  };

  const judge = (
    id: string,
    law: JsonObject,
    available: readonly Enforcer[],
  ): LawReport => {
    const at = String(law.at);
    const requires = isObject(law.requires) ? law.requires : {};
    const reasons = Object.entries(requires).map(([path, condition]) =>
      reasonFor(path, isObject(condition) ? condition : {}),
    );
    const base = { id, says: String(law.says), at, reasons };
    const here = available.filter((e) => e.point === at);
    if (here.length === 0)
      return {
        ...base,
        status: "unenforced",
        detail: `no enabled block enforces ${at}, so this law is written down but nothing checks it`,
      };
    const failing = reasons.filter((r) => !r.holds);
    if (failing.length > 0)
      return {
        ...base,
        status: "broken",
        detail: `${failing.map((r) => r.pointer).join(", ")} ${failing.length === 1 ? "does" : "do"} not meet the condition`,
      };
    const names = here.map((e) => e.instance).join(", ");
    const inside = (r: LawReason) =>
      here.filter((e) => isPrefix(e.root, parsePointer(r.pointer) ?? []));
    const outside = reasons.filter((r) => inside(r).length === 0);
    const unread = reasons.filter(
      (r) =>
        inside(r).length > 0 &&
        !inside(r).some((e) => e.reads(parsePointer(r.pointer) ?? [])),
    );
    if (outside.length > 0 || unread.length > 0)
      return {
        ...base,
        status: "unenforced",
        detail: [
          ...(outside.length > 0
            ? [
                `${outside.map((r) => r.pointer).join(", ")} is outside what ${names} enforces`,
              ]
            : []),
          ...(unread.length > 0
            ? [
                `${unread.map((r) => r.pointer).join(", ")} is not a setting ${names} reads`,
              ]
            : []),
        ].join("; "),
      };
    return {
      ...base,
      status: "enforced",
      detail: `${here.map((e) => e.instance).join(", ")} enforces ${at} and every condition holds`,
    };
  };

  return {
    check() {
      const shown = config.show();
      const excluded = new Set(shown.excluded.flatMap((e) => e.problems));
      const problems = [
        // a config file that cannot be read at all, then the parts of it that are not valid; a
        // problem at the document root or in the laws section means the laws were not read
        ...shown.problems.filter((p) => !excluded.has(p)),
        ...shown.excluded
          .filter((e) => e.pointer === "" || e.pointer === "/laws")
          .flatMap((e) => e.problems),
      ];
      const section = shown.effective.laws;
      const stated = (isObject(section) ? Object.entries(section) : [])
        .filter((entry): entry is [string, JsonObject] => isObject(entry[1]))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      // the host composes blocks only when there is a law to judge
      const available = stated.length > 0 ? enforcers() : [];
      const laws = stated.map(([id, law]) => judge(id, law, available));
      return summarize(problems, laws);
    },
  };
}
