// The layers, low to high: default (each block's configSchema defaults, and the source a built-in's
// short name implies) → derived (read from the project by detectors) → project (the config file) →
// invocation (one call's overrides). The derived layer only fills block config
// values; it never adds a block instance, binds a slot or exposes anything, so detection alone can
// never switch a block, check or hook on.
import { jsonEqual } from "../../contract/schema.ts";
import type { DetectionOrigin, KeyOwner } from "../../generated/types.ts";
import {
  validateDetectionObservation,
  validateInstanceName,
} from "../../generated/validators.ts";
import {
  clone,
  digestValue,
  formatPointer,
  getIn,
  isObject,
  isPrefix,
  type JsonObject,
  leaves,
  parsePointer,
  setIn,
} from "./pointer.ts";

export type Layer = "default" | "derived" | "project" | "invocation";

const LAYER_RANK: Readonly<Record<Layer, number>> = {
  default: -1,
  derived: 0,
  project: 1,
  invocation: 2,
};

/** Keys of the project document that record provenance rather than configure anything. */
export const METADATA_KEYS: readonly string[] = [
  "schemaVersion",
  "templates",
  "owners",
];

/** A block source is one value: owning or overriding half of it means nothing. */
export function atomicSource(segments: readonly string[]): boolean {
  return (
    segments.length === 3 &&
    segments[0] === "blocks" &&
    segments[2] === "source"
  );
}

export interface DerivedEntry {
  readonly segments: readonly string[];
  readonly value: unknown;
  readonly origin: DetectionOrigin;
}

export interface Ignored {
  readonly key: string;
  readonly detector?: string;
  readonly reason: string;
}

export interface DerivedLayer {
  readonly entries: readonly DerivedEntry[];
  readonly ignored: readonly Ignored[];
}

/** Build the derived layer from detector observations; anything outside block config is ignored. */
export function deriveLayer(observations: readonly unknown[]): DerivedLayer {
  const entries: DerivedEntry[] = [];
  const ignored: Ignored[] = [];
  for (const raw of observations) {
    const checked = validateDetectionObservation(raw);
    if (!checked.ok) {
      const key = isObject(raw) && typeof raw.key === "string" ? raw.key : "";
      ignored.push({
        key,
        reason: `not a detection observation: ${checked.problems.map((p) => `${p.pointer || "/"} ${p.message}`).join("; ")}`,
      });
      continue;
    }
    const observation = checked.value;
    const detector = observation.origin.detector;
    const segments = parsePointer(observation.key) ?? [];
    const [root, instance, area, ...rest] = segments;
    if (
      root !== "blocks" ||
      instance === undefined ||
      !validateInstanceName(instance).ok ||
      area !== "config" ||
      rest.length === 0
    ) {
      ignored.push({
        key: observation.key,
        detector,
        reason:
          "derived values may only fill block config (/blocks/<instance>/config/...); detection never adds, binds or enables anything",
      });
      continue;
    }
    const clash = entries.find(
      (e) => isPrefix(e.segments, segments) || isPrefix(segments, e.segments),
    );
    if (clash !== undefined) {
      ignored.push({
        key: observation.key,
        detector,
        reason: `${clash.origin.detector} already derived ${formatPointer(clash.segments)}; the first observation wins`,
      });
      continue;
    }
    entries.push({
      segments,
      value: observation.value,
      origin: observation.origin,
    });
  }
  return { entries, ignored };
}

export interface LayerEntry {
  readonly pointer: string;
  readonly value: unknown;
  readonly layer: Layer;
  /** Where a derived value was read. */
  readonly origin?: DetectionOrigin;
  /** The template that wrote a project value, and whether it was edited since. */
  readonly owner?: KeyOwner & { readonly edited: boolean };
  /** False when a higher layer sets this key or one that contains it. */
  readonly active: boolean;
  readonly overriddenBy?: { readonly layer: Layer; readonly pointer: string };
}

export interface InvocationValue {
  readonly segments: readonly string[];
  readonly value: unknown;
}

export interface Layers {
  readonly entries: readonly LayerEntry[];
  readonly effective: JsonObject;
}

function projectLeaves(
  document: JsonObject | undefined,
): Array<{ segments: string[]; value: unknown }> {
  if (document === undefined) return [];
  return leaves(document, atomicSource).filter(
    (l) => !METADATA_KEYS.includes(l.segments[0] ?? ""),
  );
}

function emptyObject(value: unknown): boolean {
  return isObject(value) && Object.keys(value).length === 0;
}

/**
 * Merge the layers and say, for every value, which layer it came from and what it hides. `maps`
 * are keys declared as a whole: detected entries fill one only while no higher layer sets any
 * entry in it, so a project that declares its commands runs exactly those.
 */
export function resolveLayers(
  derived: DerivedLayer,
  document: JsonObject | undefined,
  invocation: readonly InvocationValue[] = [],
  defaults: readonly InvocationValue[] = [],
  maps: readonly (readonly string[])[] = [],
): Layers {
  const owners = isObject(document?.owners) ? document.owners : {};
  const raw: Array<
    Omit<LayerEntry, "active" | "pointer"> & { segments: readonly string[] }
  > = [
    ...defaults.map((v) => ({
      segments: v.segments,
      value: v.value,
      layer: "default" as const,
    })),
    ...derived.entries.map((e) => ({
      segments: e.segments,
      value: e.value,
      layer: "derived" as const,
      origin: e.origin,
    })),
    ...projectLeaves(document).map((l) => {
      const pointer = formatPointer(l.segments);
      const owner = owners[pointer];
      return isObject(owner) &&
        typeof owner.from === "string" &&
        typeof owner.baseline === "string"
        ? {
            segments: l.segments,
            value: l.value,
            layer: "project" as const,
            owner: {
              from: owner.from,
              baseline: owner.baseline,
              edited: digestValue(l.value) !== owner.baseline,
            },
          }
        : { segments: l.segments, value: l.value, layer: "project" as const };
    }),
    ...invocation.map((v) => ({
      segments: v.segments,
      value: v.value,
      layer: "invocation" as const,
    })),
  ];

  // An empty object is explicit at or inside a declared map, or when a lower layer sets that
  // very key. Other empty containers leave lower-layer objects intact.
  const explicit = (entry: (typeof raw)[number]): boolean =>
    !emptyObject(entry.value) ||
    maps.some((map) => isPrefix(map, entry.segments)) ||
    raw.some(
      (other) =>
        LAYER_RANK[other.layer] < LAYER_RANK[entry.layer] &&
        isPrefix(other.segments, entry.segments) &&
        isPrefix(entry.segments, other.segments),
    );
  // A derived entry inside a map the project (or the call) declares is replaced by that map.
  const declaredMap = (
    entry: (typeof raw)[number],
  ): { layer: Layer; segments: readonly string[] } | undefined => {
    if (entry.layer !== "derived") return undefined;
    const map = maps.find((m) => isPrefix(m, entry.segments));
    const declarer =
      map &&
      raw.find(
        (other) =>
          LAYER_RANK[other.layer] > LAYER_RANK[entry.layer] &&
          explicit(other) &&
          isPrefix(map, other.segments),
      );
    return declarer && map && { layer: declarer.layer, segments: map };
  };
  const effective: JsonObject = {};
  for (const entry of [...raw].sort(
    (a, b) => LAYER_RANK[a.layer] - LAYER_RANK[b.layer],
  )) {
    if (declaredMap(entry) !== undefined) continue;
    if (!explicit(entry) && isObject(getIn(effective, entry.segments)))
      continue;
    setIn(effective, entry.segments, clone(entry.value));
  }

  const entries = raw.map((entry): LayerEntry => {
    const hider =
      raw.find(
        (other) =>
          LAYER_RANK[other.layer] > LAYER_RANK[entry.layer] &&
          explicit(other) &&
          (isPrefix(other.segments, entry.segments) ||
            (isPrefix(entry.segments, other.segments) &&
              !isObject(entry.value))),
      ) ?? declaredMap(entry);
    const { segments, ...rest } = entry;
    const pointer = formatPointer(segments);
    return hider === undefined
      ? { pointer, ...rest, active: true }
      : {
          pointer,
          ...rest,
          active: false,
          overriddenBy: {
            layer: hider.layer,
            pointer: formatPointer(hider.segments),
          },
        };
  });
  entries.sort(
    (a, b) =>
      a.pointer.localeCompare(b.pointer) ||
      LAYER_RANK[b.layer] - LAYER_RANK[a.layer],
  );
  return { entries, effective };
}

/** Entries at, under or covering one pointer. */
export function entriesAt(
  layers: Layers,
  segments: readonly string[],
): readonly LayerEntry[] {
  return layers.entries.filter((entry) => {
    const at = parsePointer(entry.pointer) ?? [];
    return isPrefix(segments, at) || isPrefix(at, segments);
  });
}

export function sameValue(a: unknown, b: unknown): boolean {
  return jsonEqual(a, b);
}
