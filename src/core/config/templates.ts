// template.* operations. Importing copies a template's config into the project as plain, editable
// config; compare, update and remove then work key by key against one merge model.
//
// The model. Per key path there are three values: (a) the user's value, which is whatever the
// config file holds unless it is a template's value left unchanged; (b) each imported template's
// value at the version recorded in `templates` (id@version + digest); (c) the base: the last value
// the owning template contributed that the project took, kept as the owner record's `baseline`.
// Every operation (import, update, remove; save writes only where nothing is set and makes what it
// writes the user's) is one deterministic three-way decision per key path:
// - the user's value always wins: a template value is applied only where the project still holds
//   that template's base (or nothing, for a key the template never set);
// - a template change where the user diverged from the base is a conflict, held with nothing
//   written until the caller accepts it; a template that did not change a key never conflicts;
// - key paths that overlap (one a prefix of another: a value becoming an object or back) are
//   decided together at their highest path, and a held conflict there holds every key below it;
// - a key a template gives up (removed, or dropped by an update) that the project still holds
//   unchanged passes, in import order, to the first other imported template that sets the same
//   value and is installed at exactly the imported version and digest. If none does but one of
//   them is not available like that, the key stays unowned, since whether it needs the key is
//   unknown. Only otherwise is the key removed, so removal leaves only keys someone may still own.
// The decisions are in merge.ts; this file runs them inside one compare-and-set edit.
import { jsonEqual } from "../../contract/schema.ts";
import { DEFAULT_PARSE_LIMITS } from "../../contract/untrusted.ts";
import { ForgeFailure } from "../../contract/failure.ts";
import type {
  TemplateDocument,
  TemplateProvenance,
} from "../../generated/types.ts";
import {
  validateRelativePath,
  validateTemplateDocument,
} from "../../generated/validators.ts";
import {
  type ConfigEnvironment,
  planBytes,
  type WriteResult,
  writable,
} from "./config.ts";
import type { Change } from "./document.ts";
import { MAX_TEMPLATE_FILE_BYTES, readProjectFile } from "./files.ts";
import { atomicSource, METADATA_KEYS } from "./layers.ts";
import { applyStep, plan, type Step, templateIdOf } from "./merge.ts";
import {
  digestValue,
  formatPointer,
  getIn,
  hasIn,
  isObject,
  isPrefix,
  type JsonObject,
  leaves,
  parsePointer,
  removeIn,
} from "./pointer.ts";
import { CONFIG_FILE, commit, readProject } from "./store.ts";

/** Templates the installation can see: shipped ones, the user's own and community packages. */
export interface TemplateSource {
  list(): readonly TemplateDocument[];
  get(id: string): TemplateDocument | undefined;
}

export interface TemplateEnvironment extends ConfigEnvironment {
  readonly templates: TemplateSource;
}

export type KeyChangeKind =
  "add" | "change" | "remove" | "conflict" | "kept" | "adopt";

export interface KeyChange {
  readonly pointer: string;
  readonly kind: KeyChangeKind;
  readonly current?: unknown;
  readonly upstream?: unknown;
  readonly reason?: string;
}

export interface TemplateSummary {
  readonly id: string;
  readonly version: string;
  readonly summary: string;
  /** The exact version imported into this project, or null. */
  readonly imported: string | null;
}

export interface ImportResult extends WriteResult {
  readonly template: string;
  readonly added: readonly string[];
  /** Keys already present with the same value; left as they were. */
  readonly shared: readonly string[];
  /** Keys already present with a different value; left as they were. */
  readonly conflicts: readonly KeyChange[];
}

export interface CompareResult {
  readonly template: string;
  readonly imported: string;
  readonly upstream: string;
  readonly revision: string;
  readonly changes: readonly KeyChange[];
}

export interface UpdateResult extends WriteResult {
  readonly template: string;
  readonly applied: readonly KeyChange[];
  /** Conflicts left alone; pass their pointers in `accept` to take the upstream value. */
  readonly conflicts: readonly KeyChange[];
}

export interface RemoveResult extends WriteResult {
  readonly template: string;
  readonly removed: readonly string[];
  /** Keys kept because they were edited after import, are shared or are still needed. */
  readonly kept: readonly KeyChange[];
}

export interface TemplateApi {
  list(): { readonly templates: readonly TemplateSummary[] };
  show(input: { readonly template: string }): {
    readonly template: TemplateDocument | null;
    readonly imported: TemplateProvenance | null;
    readonly owned: readonly {
      readonly pointer: string;
      readonly edited: boolean;
    }[];
  };
  importTemplate(input: {
    readonly template: string;
    readonly expectRevision: string;
  }): ImportResult;
  compare(input: {
    readonly template: string;
    readonly source?: string;
  }): CompareResult;
  update(input: {
    readonly template: string;
    readonly expectRevision: string;
    readonly source?: string;
    readonly accept?: readonly string[];
  }): UpdateResult;
  remove(input: {
    readonly template: string;
    readonly expectRevision: string;
  }): RemoveResult;
}

const TEMPLATE_FILE = /\.(?:json|ya?ml)$/;
const DROPPED_EDITED = "upstream dropped it, but it was edited since import";

function refuse(message: string, repair?: string): ForgeFailure {
  return new ForgeFailure({
    code: "INPUT_INVALID",
    message,
    retry: "never",
    ...(repair === undefined ? {} : { repair }),
  });
}

const idOf = templateIdOf;

function refOf(template: TemplateDocument): string {
  return `${template.id}@${template.version}`;
}

function provenance(document: JsonObject | undefined): TemplateProvenance[] {
  return Array.isArray(document?.templates)
    ? (document.templates as TemplateProvenance[])
    : [];
}

function owners(document: JsonObject): JsonObject {
  if (!Object.hasOwn(document, "owners")) document.owners = {};
  if (!isObject(document.owners)) {
    throw new ForgeFailure({
      code: "INPUT_INVALID",
      message: "the planned config has invalid /owners; expected an object",
      pointer: "/owners",
      retry: "never",
    });
  }
  return document.owners;
}

/** Owner records left empty are dropped, so a project without templates has none. */
function tidy(document: JsonObject): void {
  if (isObject(document.owners) && Object.keys(document.owners).length === 0)
    delete document.owners;
}

/** Template payloads contain only config values; Forge alone writes provenance. */
function templateLeaves(template: TemplateDocument): Map<string, unknown> {
  return new Map(
    leaves(template.config, atomicSource)
      .filter((l) => !METADATA_KEYS.includes(l.segments[0] ?? ""))
      .map((l) => [formatPointer(l.segments), l.value]),
  );
}

/** A decided step as the operations report it. */
function report(
  step: Step,
  reason?: string,
  kind: KeyChangeKind = step.kind === "shared" || step.kind === "drop"
    ? "kept"
    : step.kind,
): KeyChange {
  const why = reason ?? step.reason;
  return {
    pointer: step.pointer,
    kind,
    ...(step.present ? { current: step.current } : {}),
    ...(step.theirs.size > 0 ? { upstream: step.upstream } : {}),
    ...(why === undefined ? {} : { reason: why }),
  };
}

const byPointer = (a: KeyChange, b: KeyChange): number =>
  a.pointer.localeCompare(b.pointer);

export function createTemplates(env: TemplateEnvironment): TemplateApi {
  const load = (reference: string): TemplateDocument => {
    if (TEMPLATE_FILE.test(reference)) {
      const path = reference.replace(/^\.\//, "");
      if (!validateRelativePath(path).ok) {
        throw refuse(`${reference} is not a project-relative path`);
      }
      const bytes = readProjectFile(env.files, path, MAX_TEMPLATE_FILE_BYTES);
      if (bytes === undefined) throw refuse(`no template file at ${path}`);
      const decoded = env.codec.decode(
        new TextDecoder().decode(bytes),
        env.limits ?? DEFAULT_PARSE_LIMITS,
      );
      if (!decoded.ok)
        throw new ForgeFailure({
          ...decoded.error,
          message: `${path}: ${decoded.error.message}`,
        });
      const checked = validateTemplateDocument(decoded.value);
      if (!checked.ok) {
        const [first] = checked.problems;
        throw refuse(
          `${path} is not a forge.template/1 document: ${first?.pointer || "/"} ${first?.message ?? ""}`,
        );
      }
      return checked.value;
    }
    const id = idOf(reference);
    const version = reference.includes("@")
      ? reference.slice(id.length + 1)
      : undefined;
    const found = env.templates.get(id);
    if (found === undefined) {
      throw refuse(
        `no installed template is named ${id}`,
        `installed: ${env.templates.list().map(refOf).join(", ") || "none"}; a template file path (.json or .yaml) also works`,
      );
    }
    if (version !== undefined && found.version !== version) {
      throw refuse(`${id} is installed at ${found.version}, not ${version}`);
    }
    return found;
  };

  const importedRef = (
    document: JsonObject | undefined,
    id: string,
  ): string | undefined =>
    provenance(document).find((p) => idOf(p.template) === id)?.template;

  /**
   * The import a reference addresses. A bare id means whatever is imported; an exact ref
   * (id@version) must match the imported ref, so a stale ref cannot act on a newer import.
   */
  const requireImported = (
    document: JsonObject | undefined,
    reference: string,
  ): string => {
    const id = idOf(reference);
    const ref = importedRef(document, id);
    if (ref === undefined) {
      throw refuse(
        `${id} is not imported into ${CONFIG_FILE}`,
        "see imported templates with template list",
      );
    }
    if (reference !== id && reference !== ref) {
      throw refuse(
        `${id} is imported at ${ref}, not ${reference}`,
        `address it as ${ref}, or by ${id} alone`,
      );
    }
    return ref;
  };

  /**
   * Who takes over a key template `id` gives up, in import order. A template counts only when it
   * is installed at exactly the version and digest that was imported; otherwise it is unavailable.
   */
  const successor = (
    document: JsonObject,
    id: string,
    pointer: string,
    current: unknown,
  ): { readonly ref: string; readonly why?: string } | undefined => {
    let unavailable: { ref: string; why: string } | undefined;
    for (const p of provenance(document)) {
      if (idOf(p.template) === id) continue;
      const template = env.templates.get(idOf(p.template));
      if (template === undefined) {
        unavailable ??= { ref: p.template, why: "is not installed here" };
        continue;
      }
      if (
        refOf(template) !== p.template ||
        digestValue(template) !== p.digest
      ) {
        unavailable ??= {
          ref: p.template,
          why:
            refOf(template) === p.template
              ? "is installed here with different content than was imported"
              : `is installed here as ${refOf(template)}, not the imported version`,
        };
        continue;
      }
      const keys = templateLeaves(template);
      if (keys.has(pointer) && jsonEqual(keys.get(pointer), current))
        return { ref: p.template };
    }
    return unavailable;
  };

  /**
   * Release keys template `id` gives up while the project still holds its value: hand each over or
   * keep it unowned, else remove it. A source stays while anything else of its instance stays.
   */
  const release = (
    document: JsonObject,
    id: string,
    given: readonly Step[],
  ): { removed: string[]; kept: KeyChange[] } => {
    const kept: KeyChange[] = [];
    const removing: Step[] = [];
    for (const step of given) {
      delete owners(document)[step.pointer];
      const next = successor(document, id, step.pointer, step.current);
      if (next === undefined) {
        removing.push(step);
      } else if (next.why === undefined) {
        owners(document)[step.pointer] = {
          from: next.ref,
          baseline: digestValue(step.current),
        };
        kept.push(report(step, `${next.ref} sets the same value`, "kept"));
      } else {
        kept.push(
          report(
            step,
            `${next.ref} ${next.why}, so whether it shares this key is unknown`,
            "kept",
          ),
        );
      }
    }
    const removingSet = new Set(removing.map((s) => s.pointer));
    const removed: string[] = [];
    for (const step of removing) {
      const segments = step.segments;
      if (
        segments.length === 3 &&
        segments[0] === "blocks" &&
        segments[2] === "source"
      ) {
        const instance = segments.slice(0, 2);
        const staying = leaves(
          getIn(document, instance),
          atomicSource,
          instance,
        ).filter(
          (l) =>
            !isPrefix(segments, l.segments) &&
            !removingSet.has(formatPointer(l.segments)),
        );
        if (staying.length > 0) {
          kept.push(
            report(
              step,
              "other keys of this instance stay, so its source stays",
              "kept",
            ),
          );
          continue;
        }
      }
      removed.push(step.pointer);
    }
    for (const pointer of removed)
      removeIn(document, parsePointer(pointer) ?? []);
    return { removed, kept };
  };

  const editWith = <T>(
    op: string,
    expectRevision: string,
    change: (document: JsonObject) => T,
  ): WriteResult & { readonly detail: T } => {
    let detail: T | undefined;
    let changes: Change[] = [];
    const committed = commit(env, op, expectRevision, (current) => {
      const document = writable(current);
      detail = change(document);
      const planned = planBytes(env, current, document);
      changes = planned.changes;
      return { bytes: planned.bytes };
    });
    return {
      file: CONFIG_FILE,
      previousRevision: committed.from,
      revision: committed.to,
      receipt: committed.receipt,
      changes: committed.receipt === null ? [] : changes,
      fileRemoved: committed.fileRemoved,
      detail: detail as T,
    };
  };

  const now = (): string => new Date(env.clock.now()).toISOString();

  return {
    list() {
      const document = readProject(env).document;
      const installed = env.templates.list().map((t) => ({
        id: t.id,
        version: t.version,
        summary: t.summary,
        imported: importedRef(document, t.id) ?? null,
      }));
      const missing = provenance(document)
        .filter((p) => !installed.some((t) => t.id === idOf(p.template)))
        .map((p) => ({
          id: idOf(p.template),
          version: p.template.slice(idOf(p.template).length + 1),
          summary: "imported into this project; not installed here",
          imported: p.template,
        }));
      return { templates: [...installed, ...missing] };
    },

    show(input) {
      const document = readProject(env).document;
      const id = TEMPLATE_FILE.test(input.template)
        ? load(input.template).id
        : idOf(input.template);
      const template = TEMPLATE_FILE.test(input.template)
        ? load(input.template)
        : (env.templates.get(id) ?? null);
      const owned = Object.entries(
        isObject(document?.owners) ? document.owners : {},
      )
        .filter(
          ([, owner]) => isObject(owner) && idOf(String(owner.from)) === id,
        )
        .map(([pointer, owner]) => {
          const segments = parsePointer(pointer) ?? [];
          const baseline = isObject(owner) ? owner.baseline : undefined;
          return {
            pointer,
            edited:
              !hasIn(document, segments) ||
              digestValue(getIn(document, segments)) !== baseline,
          };
        });
      return {
        template,
        imported:
          provenance(document).find((p) => idOf(p.template) === id) ?? null,
        owned,
      };
    },

    importTemplate(input) {
      const template = load(input.template);
      const ref = refOf(template);
      const result = editWith(
        "template.import",
        input.expectRevision,
        (document) => {
          const already = importedRef(document, template.id);
          if (already !== undefined) {
            throw new ForgeFailure({
              code: "INPUT_CONFLICT",
              message: `${already} is already imported`,
              retry: "never",
              repair: `see what changed with template compare ${template.id}, then template update`,
            });
          }
          // records a hand edit left for a template that is not imported describe nothing
          const all = owners(document);
          for (const [pointer, owner] of Object.entries(all)) {
            if (isObject(owner) && idOf(String(owner.from)) === template.id)
              delete all[pointer];
          }
          const added: string[] = [];
          const shared: string[] = [];
          const conflicts: KeyChange[] = [];
          const blocks = isObject(document.blocks) ? document.blocks : {};
          const foreign = new Set(
            Object.entries(
              isObject(template.config.blocks) ? template.config.blocks : {},
            )
              .filter(([name, instance]) => {
                const mine = blocks[name];
                return (
                  isObject(mine) &&
                  Object.hasOwn(mine, "source") &&
                  !jsonEqual(mine.source, instance.source)
                );
              })
              .map(([name]) => name),
          );
          const theirs = new Map<string, unknown>();
          for (const [pointer, value] of templateLeaves(template)) {
            const segments = parsePointer(pointer) ?? [];
            if (segments[0] === "blocks" && foreign.has(segments[1] ?? "")) {
              const present = hasIn(document, segments);
              conflicts.push({
                pointer,
                kind: "conflict",
                ...(present ? { current: getIn(document, segments) } : {}),
                upstream: value,
                reason: `instance ${segments[1]} already comes from a different source`,
              });
            } else theirs.set(pointer, value);
          }
          for (const step of plan(document, template.id, theirs)) {
            if (step.kind === "shared") shared.push(...step.theirs.keys());
            else if (step.kind === "conflict") conflicts.push(report(step));
            else if (step.kind === "add") {
              applyStep(document, step, ref);
              added.push(...step.theirs.keys());
            }
          }
          tidy(document);
          document.templates = [
            ...provenance(document),
            { template: ref, digest: digestValue(template), importedAt: now() },
          ];
          return {
            added: added.sort(),
            shared: shared.sort(),
            conflicts: conflicts.sort(byPointer),
          };
        },
      );
      const { detail, ...written } = result;
      return { ...written, template: ref, ...detail };
    },

    compare(input) {
      const current = readProject(env);
      const document = writable(current);
      const id = idOf(input.template);
      const imported = requireImported(document, input.template);
      const upstream = load(input.source ?? id);
      if (upstream.id !== id)
        throw refuse(`${input.source} holds ${upstream.id}, not ${id}`);
      return {
        template: id,
        imported,
        upstream: refOf(upstream),
        revision: current.revision,
        changes: plan(document, id, templateLeaves(upstream))
          .filter((step) => step.kind !== "shared" && step.kind !== "drop")
          .map((step) =>
            step.kind === "kept" ? report(step, DROPPED_EDITED) : report(step),
          ),
      };
    },

    update(input) {
      const id = idOf(input.template);
      const upstream = load(input.source ?? id);
      if (upstream.id !== id)
        throw refuse(`${input.source} holds ${upstream.id}, not ${id}`);
      const ref = refOf(upstream);
      const accept = new Set(
        (input.accept ?? []).map((p) => formatPointer(parsePointer(p) ?? [p])),
      );
      const result = editWith(
        "template.update",
        input.expectRevision,
        (document) => {
          requireImported(document, input.template);
          const applied: KeyChange[] = [];
          const conflicts: KeyChange[] = [];
          const held: (readonly string[])[] = [];
          const giving: Step[] = [];
          for (const step of plan(document, id, templateLeaves(upstream))) {
            switch (step.kind) {
              case "conflict":
                if (accept.has(step.pointer)) {
                  applyStep(document, step, ref);
                  applied.push(report(step));
                } else {
                  // held whole: nothing at or below the root is written, its records included
                  held.push(step.segments);
                  conflicts.push(report(step));
                }
                break;
              case "add":
              case "change":
              case "adopt":
                applyStep(document, step, ref);
                applied.push(report(step));
                break;
              case "remove":
                giving.push(step);
                break;
              case "kept":
                delete owners(document)[step.pointer];
                conflicts.push(report(step, DROPPED_EDITED));
                break;
              case "drop":
                delete owners(document)[step.pointer];
                break;
              case "shared":
                break;
            }
          }
          const released = release(document, id, giving);
          const removed = new Set(released.removed);
          for (const step of giving) {
            if (removed.has(step.pointer)) applied.push(report(step));
          }
          applied.push(...released.kept);
          // the template's other records now come from the new version; held ones keep their base
          const all = owners(document);
          for (const [pointer, owner] of Object.entries(all)) {
            const segments = parsePointer(pointer) ?? [];
            if (
              isObject(owner) &&
              idOf(String(owner.from)) === id &&
              !held.some((root) => isPrefix(root, segments))
            )
              all[pointer] = { ...owner, from: ref };
          }
          tidy(document);
          document.templates = provenance(document).map((p) =>
            idOf(p.template) === id
              ? {
                  template: ref,
                  digest: digestValue(upstream),
                  importedAt: now(),
                }
              : p,
          );
          return { applied: applied.sort(byPointer), conflicts };
        },
      );
      const { detail, ...written } = result;
      return { ...written, template: ref, ...detail };
    },

    remove(input) {
      const id = idOf(input.template);
      let ref = id;
      const result = editWith(
        "template.remove",
        input.expectRevision,
        (document) => {
          ref = requireImported(document, input.template);
          const kept: KeyChange[] = [];
          const giving: Step[] = [];
          for (const step of plan(document, id, new Map())) {
            if (step.kind === "remove") {
              giving.push(step);
              continue;
            }
            delete owners(document)[step.pointer];
            if (step.kind === "kept")
              kept.push(report(step, "edited since import; it is yours now"));
          }
          const released = release(document, id, giving);
          kept.push(...released.kept);
          tidy(document);
          const rest = provenance(document).filter(
            (p) => idOf(p.template) !== id,
          );
          if (rest.length === 0) delete document.templates;
          else document.templates = rest;
          return { removed: released.removed, kept: kept.sort(byPointer) };
        },
      );
      const { detail, ...written } = result;
      return { ...written, template: ref, ...detail };
    },
  };
}
