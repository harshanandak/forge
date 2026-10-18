import { escapePointer } from "../../contract/schema.ts";
import type { DetectionObservation } from "../../generated/types.ts";
import type { ProjectFiles } from "./files.ts";

/** Every observation this block makes names this operation as its detector. */
export const DETECTOR = "project.detect";

/** Where a detected fact lives: always a file, optionally the place inside it. */
export interface Source {
  readonly file: string;
  /** JSON Pointer into the file, when the file is JSON. */
  readonly pointer?: string;
  /** A plain-language aside, for example that two lockfiles disagree. */
  readonly note?: string;
}

/** Facts about the project land under this prefix; commands that feed the check block land under its config. */
export const DETECTED = "/blocks/project/detected";
export const COMMANDS = "/blocks/check/config/commands";

/** A pointer made of plain segments, each escaped. */
export function pointer(...segments: readonly string[]): string {
  return segments.map((segment) => `/${escapePointer(segment)}`).join("");
}

export function detected(
  area: string,
  segments: readonly string[],
  value: unknown,
  source: Source,
): DetectionObservation {
  return observe(`${DETECTED}${pointer(area, ...segments)}`, value, source);
}

export function command(
  name: string,
  value: string,
  source: Source,
): DetectionObservation {
  return observe(`${COMMANDS}${pointer(name)}`, value, source);
}

export function observe(
  key: string,
  value: unknown,
  source: Source,
): DetectionObservation {
  return {
    key,
    value,
    origin: {
      detector: DETECTOR,
      file: source.file,
      ...(source.pointer === undefined ? {} : { pointer: source.pointer }),
      ...(source.note === undefined ? {} : { note: source.note }),
    },
  };
}

/** Parse a JSON file; `undefined` for missing, `null` for present-but-malformed. */
export function readJson(
  files: ProjectFiles,
  path: string,
): Record<string, unknown> | null | undefined {
  const text = files.read(path);
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The first of `names` that exists, in the order given. */
export function firstExisting(
  files: ProjectFiles,
  names: readonly string[],
): string | undefined {
  return names.find((name) => files.exists(name));
}
