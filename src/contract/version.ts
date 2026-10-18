// Version grammar: Semantic Versioning 2.0.0 versions, comparator ranges, and interface references
// typed as `interface@major` (required) and `interface@major.minor.patch` (provided).
import {
  validateInterfaceRef,
  validateInterfaceVersionRef,
  validateSemVer,
  validateVersionRange,
} from "../generated/validators.ts";

export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
}

export function parseVersion(version: string): ParsedVersion | undefined {
  if (!validateSemVer(version).ok) return undefined;
  const [core = "", ...rest] = version.split("+")[0]?.split("-") ?? [];
  const [major = 0, minor = 0, patch = 0] = core.split(".").map(Number);
  const pre = rest.join("-");
  const prerelease =
    pre === ""
      ? []
      : pre.split(".").map((id) => (/^[0-9]+$/.test(id) ? Number(id) : id));
  return { major, minor, patch, prerelease };
}

function compareIdentifiers(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return Math.sign(a - b);
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Precedence per SemVer 2.0.0 §11; build metadata is ignored. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return Math.sign(a[key] - b[key]);
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const order = compareIdentifiers(left, right);
    if (order !== 0) return order;
  }
  return 0;
}

/** Whether `version` meets every comparator in `range`; false when either is malformed. */
export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  if (parsed === undefined || !validateVersionRange(range).ok) return false;
  return range.split(" ").every((comparator) => {
    const match = /^(>=|<=|>|<|=)?(.+)$/.exec(comparator);
    const bound = parseVersion(match?.[2] ?? "");
    if (bound === undefined) return false;
    const order = compareVersions(parsed, bound);
    switch (match?.[1] ?? "=") {
      case ">=":
        return order >= 0;
      case "<=":
        return order <= 0;
      case ">":
        return order > 0;
      case "<":
        return order < 0;
      default:
        return order === 0;
    }
  });
}

export interface InterfaceRequirement {
  readonly id: string;
  readonly major: number;
}

export interface InterfaceProvision {
  readonly id: string;
  readonly version: ParsedVersion;
}

export function parseInterfaceRef(
  ref: string,
): InterfaceRequirement | undefined {
  if (!validateInterfaceRef(ref).ok) return undefined;
  const at = ref.lastIndexOf("@");
  return { id: ref.slice(0, at), major: Number(ref.slice(at + 1)) };
}

export function parseInterfaceVersionRef(
  ref: string,
): InterfaceProvision | undefined {
  if (!validateInterfaceVersionRef(ref).ok) return undefined;
  const at = ref.lastIndexOf("@");
  const version = parseVersion(ref.slice(at + 1));
  return version === undefined ? undefined : { id: ref.slice(0, at), version };
}

/** A provider at `id@M.n.p` satisfies a requirement for `id@M`. */
export function interfaceSatisfies(
  provided: string,
  required: string,
): boolean {
  const provision = parseInterfaceVersionRef(provided);
  const requirement = parseInterfaceRef(required);
  return (
    provision !== undefined &&
    requirement !== undefined &&
    provision.id === requirement.id &&
    provision.version.major === requirement.major
  );
}
