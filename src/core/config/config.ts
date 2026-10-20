// config.* operations: the three ways in. Do nothing and the derived layer mirrors the project;
// change one thing at a time with compare-and-set edits; or import a template (templates.ts).
// Reads never write: show, explain and detect only read files.
import { ForgeFailure } from "../../contract/failure.ts";
import type {
  BlockSource,
  ParseLimits,
  TemplateProvenance,
} from "../../generated/types.ts";
import type { ClockPort } from "../../ports/clock.ts";
import type { ConfigCodecPort } from "../../ports/config-codec.ts";
import {
  type BlockConfigSchema,
  type BlockLookup,
  type Change,
  checkDocument,
  checkInstanceConfig,
  diff,
  emptyDocument,
  encodeDocument,
  fillSources,
} from "./document.ts";
import { validateConfigDocument } from "../../generated/validators.ts";
import {
  MAX_CONFIG_FILE_BYTES,
  readProjectFile,
  type ConfigFiles,
} from "./files.ts";
import {
  type DerivedLayer,
  deriveLayer,
  entriesAt,
  type Ignored,
  type InvocationValue,
  type LayerEntry,
  type Layers,
  METADATA_KEYS,
  resolveLayers,
} from "./layers.ts";
import { absoluteUses, schemaDefaults } from "./short.ts";
import {
  clone,
  formatPointer,
  getIn,
  hasIn,
  isObject,
  type JsonObject,
  parsePointer,
  removeIn,
  setIn,
  toPointer,
} from "./pointer.ts";
import {
  CONFIG_FILE,
  type Committed,
  HISTORY_DIR,
  commit,
  decodeReceiptBytes,
  type ProjectConfig,
  readHistory,
  readProject,
  type StoreDeps,
} from "./store.ts";

export interface ConfigEnvironment extends StoreDeps, BlockLookup {
  readonly files: ConfigFiles;
  readonly codec: ConfigCodecPort;
  readonly clock: ClockPort;
  /** Observations from the installed detector operations, read afresh on every call. */
  readonly detect: () => readonly unknown[];
  readonly limits?: ParseLimits;
}

export interface Instance {
  readonly name: string;
  readonly source: BlockSource;
  readonly enabled: boolean;
}

export interface ShowResult {
  readonly file: string;
  readonly revision: string;
  /** False when the project has no config file (or an empty one): everything comes from detection. */
  readonly configured: boolean;
  /** Block instances the project config switches on. Detection alone never adds one. */
  readonly instances: readonly Instance[];
  readonly templates: readonly TemplateProvenance[];
  readonly values: readonly LayerEntry[];
  readonly ignored: readonly Ignored[];
  /** Why the config file cannot be used as it is, if it cannot. */
  readonly problems: readonly string[];
  /** Parts of the file left out of every other field because they are not valid, with where they are. */
  readonly excluded: readonly Excluded[];
  readonly effective: JsonObject;
}

export interface Excluded {
  readonly pointer: string;
  readonly problems: readonly string[];
}

/**
 * The part of a decoded document a schema problem makes unusable: a whole block instance, template
 * record or owner record, else the top-level key. Show leaves these out and reports them instead.
 */
function excludedAt(pointer: string): string[] {
  const segments = parsePointer(pointer) ?? [];
  const [top] = segments;
  if (top === undefined) return [];
  if (
    (top === "blocks" || top === "templates" || top === "owners") &&
    segments.length >= 2
  )
    return segments.slice(0, 2);
  return [top];
}

/**
 * The document with every invalid part removed, and what was removed. `implied` lists the sources
 * filled in from a built-in's short name; they are not in the file, so they resolve as defaults.
 */
function usable(
  document: JsonObject | undefined,
  lookup: BlockLookup,
): {
  document: JsonObject | undefined;
  excluded: Excluded[];
  implied: string[];
} {
  if (document === undefined) return { document, excluded: [], implied: [] };
  const filled = clone(document);
  const implied = fillSources(filled, lookup);
  const checked = validateConfigDocument(filled);
  const uses = absoluteUses(filled);
  if (checked.ok && uses.length === 0)
    return { document: filled, excluded: [], implied };
  // an absolute `use` is its instance's whole problem; the schema's echoes of it add nothing
  const flagged = uses.map((u) => u.pointer.replace(/\/use$/, ""));
  const problems = [
    ...uses,
    ...(checked.ok ? [] : checked.problems).filter(
      (p) =>
        !flagged.some((f) => p.pointer === f || p.pointer.startsWith(`${f}/`)),
    ),
  ];
  const byUnit = new Map<string, string[]>();
  for (const problem of problems) {
    const unit = formatPointer(excludedAt(problem.pointer));
    const found = byUnit.get(unit) ?? [];
    found.push(`${problem.pointer || "/"} ${problem.message}`);
    byUnit.set(unit, found);
  }
  const excluded = [...byUnit.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pointer, problems]) => ({ pointer, problems }));
  if (byUnit.has("")) return { document: undefined, excluded, implied: [] };
  const dropped = new Set<number>();
  for (const { pointer } of excluded) {
    const segments = parsePointer(pointer) ?? [];
    // template records are array items: drop them together so the indices stay right
    if (segments[0] === "templates" && segments.length === 2)
      dropped.add(Number(segments[1]));
    else removeIn(filled, segments);
  }
  if (Array.isArray(filled.templates) && dropped.size > 0)
    filled.templates = filled.templates.filter((_, i) => !dropped.has(i));
  return {
    document: filled,
    excluded,
    implied: implied.filter((p) => hasIn(filled, parsePointer(p) ?? [])),
  };
}

/** Each configured instance's block config schema, if its block supplies one. */
function blockSchemas(
  document: JsonObject | undefined,
  lookup: BlockLookup,
): Array<[string, BlockConfigSchema]> {
  const blocks = isObject(document?.blocks) ? document.blocks : {};
  return Object.entries(blocks).flatMap(([name, instance]) => {
    if (!isObject(instance) || !isObject(instance.source)) return [];
    const schema = lookup.blockConfig?.(
      name,
      instance.source as unknown as BlockSource,
    );
    return schema === undefined ? [] : [[name, schema] as const];
  });
}

/**
 * The one effective-config resolver: default < derived < project file < invocation. The default
 * layer is each instance's configSchema defaults plus the sources `implied` by short names.
 */
function resolve(
  lookup: BlockLookup,
  document: JsonObject | undefined,
  implied: readonly string[],
  derived: DerivedLayer,
  invocation: readonly InvocationValue[] = [],
): Layers {
  const project = document === undefined ? undefined : clone(document);
  const defaults: InvocationValue[] = [];
  for (const pointer of implied) {
    const segments = parsePointer(pointer) ?? [];
    defaults.push({ segments, value: getIn(document ?? {}, segments) });
    if (project !== undefined) removeIn(project, segments);
  }
  for (const [name, { schema }] of blockSchemas(document, lookup))
    for (const { key, value } of schemaDefaults(schema))
      defaults.push({ segments: ["blocks", name, "config", key], value });
  return resolveLayers(derived, project, invocation, defaults);
}

/** Where a value came from: a block's schema default, detection, the file, a template, or the call. */
export type ValueSource =
  "default" | "derived" | "project" | "template" | "invocation";

function sourceOf(entry: LayerEntry): ValueSource {
  if (entry.layer !== "project") return entry.layer;
  return entry.owner !== undefined && !entry.owner.edited
    ? "template"
    : "project";
}

/**
 * Put a derived value into the project document without replacing anything the project sets: an
 * object is merged key by key, and a key the project already has (at any depth) stays as it is.
 * Returns true when anything was written.
 */
function fillMissing(
  document: JsonObject,
  segments: readonly string[],
  value: unknown,
): boolean {
  for (let depth = 1; depth < segments.length; depth += 1) {
    const ancestor = segments.slice(0, depth);
    if (hasIn(document, ancestor) && !isObject(getIn(document, ancestor)))
      return false;
  }
  if (!hasIn(document, segments)) {
    setIn(document, segments, clone(value));
    return true;
  }
  const current = getIn(document, segments);
  if (!isObject(current) || !isObject(value)) return false;
  let wrote = false;
  for (const [key, inner] of Object.entries(value)) {
    if (fillMissing(document, [...segments, key], inner)) wrote = true;
  }
  return wrote;
}

export interface ExplainResult {
  readonly pointer: string;
  readonly set: boolean;
  readonly value: unknown;
  readonly layer: LayerEntry["layer"] | null;
  readonly source: ValueSource | null;
  readonly entries: readonly LayerEntry[];
}

export interface PatchStep {
  readonly op: "set" | "remove";
  readonly path: string;
  readonly value?: unknown;
}

export interface WriteResult {
  readonly file: string;
  readonly previousRevision: string;
  readonly revision: string;
  /** Receipt that config.revert undoes; null when nothing changed. */
  readonly receipt: string | null;
  readonly changes: readonly Change[];
  /** True when the edit removed the file because nothing is configured any more. */
  readonly fileRemoved: boolean;
}

export interface PreviewResult {
  readonly file: string;
  readonly revision: string;
  readonly valid: boolean;
  readonly error?: ForgeFailure["error"];
  readonly changes: readonly Change[];
  /** The file text the edit would write; null when it would remove the file. */
  readonly text: string | null;
}

export interface SaveResult extends WriteResult {
  readonly saved: readonly string[];
  readonly skipped: readonly {
    readonly pointer: string;
    readonly reason: string;
  }[];
}

function invalidPath(path: string): ForgeFailure {
  return new ForgeFailure({
    code: "INPUT_INVALID",
    message: `"${path}" is not a config path`,
    retry: "never",
    repair:
      "use a JSON Pointer such as /blocks/<instance>/config/<key>, or <instance>.<key> for an instance's config",
  });
}

function segmentsOf(path: string): string[] {
  const segments = toPointer(path);
  if (segments === undefined) throw invalidPath(path);
  return segments;
}

/** Edits go through the config API, never into provenance records directly. */
function refuseMetadata(path: string, segments: readonly string[]): void {
  if (segments.length === 0 || METADATA_KEYS.includes(segments[0] ?? "")) {
    throw new ForgeFailure({
      code: "INPUT_INVALID",
      message: `${path} is managed by Forge and cannot be edited directly`,
      retry: "never",
      repair:
        "import, update or remove templates with template import, template update and template remove",
    });
  }
}

export function writable(current: ProjectConfig): JsonObject {
  if (current.unreadable !== undefined) {
    throw new ForgeFailure({
      ...current.unreadable,
      repair: `fix ${CONFIG_FILE} by hand, or undo the edit that broke it with config revert`,
    });
  }
  return current.document === undefined
    ? emptyDocument()
    : clone(current.document);
}

export function planBytes(
  env: ConfigEnvironment,
  current: ProjectConfig,
  next: JsonObject,
): { bytes: Uint8Array | null; changes: Change[] } {
  if (!Object.hasOwn(next, "blocks")) next.blocks = {};
  fillSources(next, env);
  checkDocument(next);
  // check what the block will run with, so a detected or default value counts without being saved
  const { effective } = resolve(env, next, [], deriveLayer(env.detect()));
  for (const [name, schema] of blockSchemas(next, env))
    checkInstanceConfig(
      name,
      schema.check(getIn(effective, ["blocks", name, "config"]) ?? {}),
    );
  const bytes = encodeDocument(next, env.codec);
  const after = bytes === null ? undefined : next;
  return { bytes, changes: diff(current.document, after) };
}

function written(
  committed: Committed,
  changes: readonly Change[],
): WriteResult {
  return {
    file: CONFIG_FILE,
    previousRevision: committed.from,
    revision: committed.to,
    receipt: committed.receipt,
    changes: committed.receipt === null ? [] : changes,
    fileRemoved: committed.fileRemoved,
  };
}

function applySteps(
  document: JsonObject,
  steps: readonly PatchStep[],
): JsonObject {
  if (steps.length === 0) {
    throw new ForgeFailure({
      code: "INPUT_INVALID",
      message: "the patch has no steps",
      retry: "never",
    });
  }
  for (const step of steps) {
    const segments = segmentsOf(step.path);
    refuseMetadata(step.path, segments);
    if (step.op === "set") {
      if (step.value === undefined) {
        throw new ForgeFailure({
          code: "INPUT_INVALID",
          message: `the set step for ${step.path} has no value`,
          retry: "never",
        });
      }
      setIn(document, segments, clone(step.value));
    } else {
      removeIn(document, segments);
    }
  }
  return document;
}

export interface ConfigApi {
  show(input?: { readonly invocation?: readonly PatchStep[] }): ShowResult;
  explain(input: { readonly path: string }): ExplainResult;
  detect(): DetectResult;
  preview(input: { readonly patch: readonly PatchStep[] }): PreviewResult;
  apply(input: {
    readonly patch: readonly PatchStep[];
    readonly expectRevision: string;
  }): WriteResult;
  set(input: {
    readonly path: string;
    readonly value: unknown;
    readonly expectRevision: string;
  }): WriteResult;
  revert(input: {
    readonly expectRevision: string;
    readonly receipt?: string;
  }): RevertResult;
  save(input: {
    readonly expectRevision: string;
    readonly paths?: readonly string[];
  }): SaveResult;
}

export interface DetectResult {
  readonly observations: readonly LayerEntry[];
  readonly ignored: readonly Ignored[];
}

export interface RevertResult extends WriteResult {
  /** The receipt whose edit was undone. */
  readonly reverted: string;
}

export function createConfig(env: ConfigEnvironment): ConfigApi {
  const derive = (): DerivedLayer => deriveLayer(env.detect());

  const edit = (
    op: string,
    expectRevision: string,
    change: (document: JsonObject, current: ProjectConfig) => JsonObject,
  ): WriteResult => {
    let changes: Change[] = [];
    const committed = commit(env, op, expectRevision, (current) => {
      const planned = planBytes(
        env,
        current,
        change(writable(current), current),
      );
      changes = planned.changes;
      return { bytes: planned.bytes };
    });
    return written(committed, changes);
  };

  return {
    show(input = {}) {
      const current = readProject(env);
      const derived = derive();
      const invocation: InvocationValue[] = (input.invocation ?? [])
        .filter((step) => step.op === "set")
        .map((step) => ({
          segments: segmentsOf(step.path),
          value: step.value,
        }));
      const { document, excluded, implied } = usable(current.document, env);
      const layers = resolve(env, document, implied, derived, invocation);
      const blocks = isObject(document?.blocks) ? document.blocks : {};
      const instances: Instance[] = [];
      for (const [name, instance] of Object.entries(blocks)) {
        if (!isObject(instance) || !isObject(instance.source)) continue;
        instances.push({
          name,
          source: instance.source as unknown as BlockSource,
          enabled: instance.enabled !== false,
        });
      }
      return {
        file: CONFIG_FILE,
        revision: current.revision,
        configured:
          current.document !== undefined || current.unreadable !== undefined,
        instances,
        templates: Array.isArray(document?.templates)
          ? (document.templates as TemplateProvenance[])
          : [],
        values: layers.entries,
        ignored: derived.ignored,
        problems: [
          ...(current.unreadable === undefined
            ? []
            : [current.unreadable.message]),
          ...excluded.flatMap((e) => e.problems),
        ],
        excluded,
        effective: layers.effective,
      };
    },

    explain(input) {
      const segments = segmentsOf(input.path);
      const current = readProject(env);
      const { document, implied } = usable(current.document, env);
      const layers = resolve(env, document, implied, derive());
      const entries = entriesAt(layers, segments);
      const set = hasIn(layers.effective, segments);
      const exact = entries.find(
        (e) => e.active && e.pointer === formatPointer(segments),
      );
      return {
        pointer: formatPointer(segments),
        set,
        value: set ? (getIn(layers.effective, segments) ?? null) : null,
        layer: exact?.layer ?? null,
        source: exact === undefined ? null : sourceOf(exact),
        entries,
      };
    },

    detect() {
      const derived = derive();
      return {
        observations: resolveLayers(derived, undefined).entries,
        ignored: derived.ignored,
      };
    },

    preview(input) {
      const current = readProject(env);
      try {
        const next = applySteps(writable(current), input.patch);
        const planned = planBytes(env, current, next);
        return {
          file: CONFIG_FILE,
          revision: current.revision,
          valid: true,
          changes: planned.changes,
          text:
            planned.bytes === null
              ? null
              : new TextDecoder().decode(planned.bytes),
        };
      } catch (error) {
        if (!(error instanceof ForgeFailure)) throw error;
        return {
          file: CONFIG_FILE,
          revision: current.revision,
          valid: false,
          error: error.error,
          changes: [],
          text: null,
        };
      }
    },

    apply(input) {
      return edit("config.apply", input.expectRevision, (document) =>
        applySteps(document, input.patch),
      );
    },

    set(input) {
      return edit("config.set", input.expectRevision, (document) =>
        applySteps(document, [
          { op: "set", path: input.path, value: input.value },
        ]),
      );
    },

    revert(input) {
      let reverted = "";
      let changes: Change[] = [];
      const committed = commit(
        env,
        "config.revert",
        input.expectRevision,
        (current) => {
          const { receipts, damaged } = readHistory(env);
          const broken =
            input.receipt === undefined
              ? undefined
              : damaged.find(
                  (d) => d.file === `${HISTORY_DIR}/${input.receipt}.json`,
                );
          if (broken !== undefined) {
            throw new ForgeFailure({
              code: "INPUT_INVALID",
              message: `receipt ${broken.file} is damaged (${broken.problem}); it is never applied`,
              retry: "never",
              repair: `restore ${CONFIG_FILE} by hand or from version control`,
            });
          }
          const undone = new Set(
            receipts.flatMap((r) =>
              r.reverts === undefined ? [] : [r.reverts],
            ),
          );
          const target =
            input.receipt === undefined
              ? receipts.findLast(
                  (r) =>
                    r.to === current.revision &&
                    r.reverts === undefined &&
                    !undone.has(r.id),
                )
              : receipts.find((r) => r.id === input.receipt);
          if (target === undefined) {
            throw new ForgeFailure({
              code: "INPUT_INVALID",
              message:
                input.receipt === undefined
                  ? `no recorded edit produced the current ${CONFIG_FILE}; there is nothing to revert`
                  : `no receipt "${input.receipt}" is recorded`,
              retry: "never",
              ...(damaged.length === 0
                ? {}
                : {
                    repair: `damaged receipts were ignored and never applied: ${damaged.map((d) => `${d.file} (${d.problem})`).join("; ")}`,
                  }),
            });
          }
          if (target.to !== current.revision) {
            throw new ForgeFailure({
              code: "REVISION_CONFLICT",
              message: `${CONFIG_FILE} changed after edit ${target.id}; reverting it would discard the later change`,
              retry: "reconcile_first",
              expected: target.to,
              observed: current.revision,
              reconcileWith: "config.show",
            });
          }
          reverted = target.id;
          const bytes = decodeReceiptBytes(target);
          const before = readProject({
            ...env,
            files: {
              ...env.files,
              read: (path) =>
                path === CONFIG_FILE
                  ? (bytes ?? undefined)
                  : readProjectFile(env.files, path, MAX_CONFIG_FILE_BYTES),
            },
          });
          changes = diff(current.document, before.document);
          return { bytes, reverts: target.id };
        },
      );
      return { ...written(committed, changes), reverted };
    },

    save(input) {
      const saved: string[] = [];
      const skipped: Array<{ pointer: string; reason: string }> = [];
      const only = input.paths?.map((p) => formatPointer(segmentsOf(p)));
      const result = edit(
        "config.save",
        input.expectRevision,
        (document, current) => {
          // a key a template owned but the project no longer holds: what save writes there is the
          // user's value, so that template's record goes (see the merge model in templates.ts)
          const owners = isObject(document.owners) ? document.owners : {};
          const vacant = Object.keys(owners).filter(
            (p) => !hasIn(document, parsePointer(p) ?? []),
          );
          const layers = resolveLayers(derive(), current.document);
          for (const entry of layers.entries) {
            if (entry.layer !== "derived" || !entry.active) continue;
            if (
              only !== undefined &&
              !only.some(
                (p) => entry.pointer === p || entry.pointer.startsWith(`${p}/`),
              )
            )
              continue;
            const segments = toPointer(entry.pointer) ?? [];
            const instance = segments[1] ?? "";
            const blocks = isObject(document.blocks) ? document.blocks : {};
            if (
              !isObject(blocks[instance]) &&
              env.builtinSource?.(instance) === undefined
            ) {
              skipped.push({
                pointer: entry.pointer,
                reason: `no block instance "${instance}" is configured and no installed block has that name; add the instance first`,
              });
              continue;
            }
            if (fillMissing(document, segments, entry.value))
              saved.push(entry.pointer);
            else
              skipped.push({
                pointer: entry.pointer,
                reason: "the project already sets this value",
              });
          }
          for (const pointer of vacant) {
            if (hasIn(document, parsePointer(pointer) ?? []))
              delete owners[pointer];
          }
          if (isObject(document.owners) && Object.keys(owners).length === 0)
            delete document.owners;
          return document;
        },
      );
      return { ...result, saved, skipped };
    },
  };
}
