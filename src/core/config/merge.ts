// The three-way decision between one template and the project config; the model is described at
// the top of templates.ts. `plan` only reads; `applyStep` writes one decided step.
import { jsonEqual } from "../../contract/schema.ts";
import { atomicSource } from "./layers.ts";
import {
  clone,
  digestValue,
  formatPointer,
  getIn,
  hasIn,
  isObject,
  isPrefix,
  type JsonObject,
  leaves,
  parsePointer,
  setIn,
} from "./pointer.ts";

export type StepKind =
  | "add"
  | "change"
  | "adopt"
  | "shared"
  | "conflict"
  | "remove"
  | "kept"
  | "drop";

/**
 * One decision for one root: the highest path of a group of key paths that overlap (one is a prefix
 * of another), so a shape change between a value and an object is always decided whole.
 */
export interface Step {
  readonly kind: StepKind;
  readonly pointer: string;
  readonly segments: readonly string[];
  /** The project's value at the root, when it has one. */
  readonly present: boolean;
  readonly current?: unknown;
  /** The template's value at the root; absent when the template no longer sets it. */
  readonly upstream?: unknown;
  /** The template's keys under the root, with their values. */
  readonly theirs: ReadonlyMap<string, unknown>;
  readonly reason?: string;
}

/** Owner records of template `id`: pointer → baseline digest (the base of the three-way merge). */
export function basesOf(document: JsonObject, id: string): Map<string, string> {
  const bases = new Map<string, string>();
  const owners = isObject(document.owners) ? document.owners : {};
  for (const [pointer, owner] of Object.entries(owners)) {
    if (
      isObject(owner) &&
      typeof owner.from === "string" &&
      typeof owner.baseline === "string" &&
      templateIdOf(owner.from) === id
    )
      bases.set(pointer, owner.baseline);
  }
  return bases;
}

export function templateIdOf(ref: string): string {
  const at = ref.lastIndexOf("@");
  return at === -1 ? ref : ref.slice(0, at);
}

/** The nearest ancestor holding a value that is not an object, which a deeper key would replace. */
function blocker(
  document: JsonObject,
  segments: readonly string[],
): string[] | undefined {
  for (let depth = 1; depth < segments.length; depth += 1) {
    const ancestor = segments.slice(0, depth);
    if (!hasIn(document, ancestor)) return undefined;
    if (!isObject(getIn(document, ancestor))) return ancestor;
  }
  return undefined;
}

function under(root: readonly string[], pointers: Iterable<string>): string[] {
  return [...pointers].filter((p) => isPrefix(root, parsePointer(p) ?? []));
}

/**
 * Decide every key path template `id` touches. `theirs` is the template's keys (empty when the
 * template is being removed); the base is the owner records; the user's value is the document.
 */
export function plan(
  document: JsonObject,
  id: string,
  theirs: ReadonlyMap<string, unknown>,
): Step[] {
  const bases = basesOf(document, id);
  const nodes = new Map<string, string[]>();
  const note = (segments: readonly string[]): void => {
    nodes.set(formatPointer(segments), [...segments]);
  };
  for (const pointer of theirs.keys()) {
    const segments = parsePointer(pointer) ?? [];
    note(segments);
    const above = blocker(document, segments);
    if (above !== undefined) note(above);
  }
  for (const pointer of bases.keys()) note(parsePointer(pointer) ?? []);

  // every node falls under exactly one root: the shortest node that is a prefix of it
  const roots: string[][] = [];
  for (const segments of [...nodes.values()].sort(
    (a, b) => a.length - b.length,
  )) {
    if (!roots.some((root) => isPrefix(root, segments))) roots.push(segments);
  }

  const steps: Step[] = [];
  for (const root of roots) {
    const pointer = formatPointer(root);
    const mine = under(root, theirs.keys());
    const owned = under(root, bases.keys());
    if (mine.length === 0) {
      // the template no longer sets anything here: each key it owns is released or stays the user's
      for (const key of owned) {
        const segments = parsePointer(key) ?? [];
        const present = hasIn(document, segments);
        const current = getIn(document, segments);
        const kind: StepKind = !present
          ? "drop"
          : digestValue(current) === bases.get(key)
            ? "remove"
            : "kept";
        steps.push({
          kind,
          pointer: key,
          segments,
          present,
          ...(present ? { current } : {}),
          theirs: new Map(),
        });
      }
      continue;
    }
    const want = new Map(mine.map((key) => [key, theirs.get(key)]));
    const unchanged =
      owned.length === mine.length &&
      mine.every((key) => bases.get(key) === digestValue(want.get(key)));
    // the template did not change anything here, so whatever the project holds stands
    if (unchanged) continue;
    const present = hasIn(document, root);
    const current = getIn(document, root);
    const upstream = want.has(pointer)
      ? want.get(pointer)
      : assemble(root, want);
    const base = {
      pointer,
      segments: root,
      present,
      ...(present ? { current } : {}),
      upstream,
      theirs: want,
    };
    if (present && jsonEqual(current, upstream)) {
      steps.push({ ...base, kind: owned.length > 0 ? "adopt" : "shared" });
      continue;
    }
    const pristine =
      owned.every((key) => hasIn(document, parsePointer(key) ?? [])) &&
      (!present ||
        leaves(current, atomicSource, root).every(
          (leaf) =>
            bases.get(formatPointer(leaf.segments)) === digestValue(leaf.value),
        ));
    if (pristine) {
      steps.push({ ...base, kind: present ? "change" : "add" });
      continue;
    }
    const why =
      owned.length > 0
        ? present
          ? "edited since import"
          : "removed since import"
        : want.has(pointer)
          ? "already set in the project"
          : "a value in the project covers this key";
    const whole =
      mine.length > 1 || !want.has(pointer) || owned.some((k) => k !== pointer);
    steps.push({
      ...base,
      kind: "conflict",
      reason: whole
        ? `${why}; the shape changes here, so accept ${pointer} to take the template's value whole`
        : why,
    });
  }
  return steps.sort((a, b) => a.pointer.localeCompare(b.pointer));
}

/** The template's value at an ancestor of its keys, built from those keys. */
function assemble(
  root: readonly string[],
  want: ReadonlyMap<string, unknown>,
): unknown {
  const built: JsonObject = {};
  for (const [key, value] of want) {
    setIn(built, (parsePointer(key) ?? []).slice(root.length), clone(value));
  }
  return built;
}

/**
 * Write a decided step: the template's value replaces everything under the root, and the template
 * owns each of its keys there with that value as the new base. Other records under the root go,
 * because the values they described are gone.
 */
export function applyStep(document: JsonObject, step: Step, ref: string): void {
  if (!isObject(document.owners)) document.owners = {};
  const owners = document.owners as JsonObject;
  if (step.kind === "adopt") {
    for (const key of under(step.segments, Object.keys(owners))) {
      const owner = owners[key];
      if (
        isObject(owner) &&
        typeof owner.from === "string" &&
        templateIdOf(owner.from) === templateIdOf(ref) &&
        !step.theirs.has(key)
      )
        delete owners[key];
    }
  } else {
    for (const key of under(step.segments, Object.keys(owners)))
      delete owners[key];
    if (step.theirs.has(step.pointer)) {
      setIn(document, step.segments, clone(step.theirs.get(step.pointer)));
    } else {
      setIn(document, step.segments, {});
      for (const [key, value] of step.theirs)
        setIn(document, parsePointer(key) ?? [], clone(value));
    }
  }
  for (const [key, value] of step.theirs)
    owners[key] = { from: ref, baseline: digestValue(value) };
}
