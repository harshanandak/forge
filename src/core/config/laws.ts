// laws.check: a read-only report of which laws the project states and whether the config backs
// each one. A law names resolved config values that must hold at a point. It is `enforced` when
// Forge enforces that point today and every condition holds, `broken` when a condition fails, and
// `unenforced` when nothing Forge runs at that point reads those values. Values come from the one
// resolver (config.show and config.explain); this module never layers or writes anything.
import { jsonEqual } from "../../contract/schema.ts";
import type { ConfigApi, ShowResult, ValueSource } from "./config.ts";
import {
  formatPointer,
  isObject,
  isPrefix,
  type JsonObject,
  parsePointer,
  toPointer,
} from "./pointer.ts";

export const LAW_POINTS = [
  "merge",
  "push",
  "commit",
  "close",
  "start",
] as const;
export type LawPoint = (typeof LAW_POINTS)[number];

export interface Enforcer {
  /** The setting Forge reads at this point, for the report. */
  readonly name: string;
  /** The block instance that runs it, and the built-in source that instance must have. */
  readonly instance: string;
  readonly source: string;
  /** The config pointer segments that setting reads; a law only counts as enforced inside it. */
  readonly root: readonly string[];
}

/**
 * The points Forge enforces today and through which config. A point with no entry is written down
 * only: Forge detects push and commit hooks but runs none, so laws there are `unenforced`.
 * Extend this one table when another point gains an enforcer.
 */
export const ENFORCERS: Readonly<Partial<Record<LawPoint, Enforcer>>> = {
  merge: {
    name: "check.gate",
    instance: "check",
    source: "forge/check",
    root: ["blocks", "check", "config", "gate"],
  },
};

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
  readonly at: LawPoint;
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

/**
 * Downgrade enforced laws whose enforcing instance is configured but cannot load. The host knows
 * which instances those are (name to reason); this module only reads config, so it takes them in.
 */
export function withUnavailable(
  report: LawsReport,
  unavailable: ReadonlyMap<string, string>,
): LawsReport {
  const laws = report.laws.map((law): LawReport => {
    const instance = ENFORCERS[law.at]?.instance;
    const reason =
      instance === undefined ? undefined : unavailable.get(instance);
    return law.status === "enforced" && reason !== undefined
      ? {
          ...law,
          status: "unenforced",
          detail: `${instance} instance cannot load: ${reason}`,
        }
      : law;
  });
  return summarize(report.problems, laws);
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
    instances: ShowResult["instances"],
  ): LawReport => {
    const at = law.at as LawPoint;
    const requires = isObject(law.requires) ? law.requires : {};
    const reasons = Object.entries(requires).map(([path, condition]) =>
      reasonFor(path, isObject(condition) ? condition : {}),
    );
    const base = { id, says: String(law.says), at, reasons };
    const enforcer = ENFORCERS[at];
    if (enforcer === undefined)
      return {
        ...base,
        status: "unenforced",
        detail: `Forge enforces nothing at ${at} today, so this law is written down but nothing checks it`,
      };
    const failing = reasons.filter((r) => !r.holds);
    if (failing.length > 0)
      return {
        ...base,
        status: "broken",
        detail: `${failing.map((r) => r.pointer).join(", ")} ${failing.length === 1 ? "does" : "do"} not meet the condition`,
      };
    const instance = instances.find((i) => i.name === enforcer.instance);
    const missing: string[] = [];
    if (instance === undefined)
      missing.push(`${enforcer.instance} instance is not configured`);
    else if (!instance.enabled)
      missing.push(`${enforcer.instance} instance is disabled`);
    else if (
      !("builtin" in instance.source) ||
      instance.source.builtin !== enforcer.source
    )
      missing.push(`${enforcer.instance} instance is not ${enforcer.source}`);
    const outside = reasons.filter(
      (r) => !isPrefix(enforcer.root, parsePointer(r.pointer) ?? []),
    );
    if (outside.length > 0)
      missing.push(
        `${enforcer.name} reads only ${formatPointer(enforcer.root)}, not ${outside.map((r) => r.pointer).join(", ")}`,
      );
    if (missing.length > 0)
      return { ...base, status: "unenforced", detail: missing.join("; ") };
    return {
      ...base,
      status: "enforced",
      detail: `${enforcer.name} reads these values and every condition holds`,
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
      const laws = (isObject(section) ? Object.entries(section) : [])
        .filter((entry): entry is [string, JsonObject] => isObject(entry[1]))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([id, law]) => judge(id, law, shown.instances));
      return summarize(problems, laws);
    },
  };
}
