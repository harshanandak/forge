// template.* operations. Importing copies a template's config into the project as plain, editable
// config and records, per key, which template wrote it and the digest of what it wrote. Compare and
// update work key by key against that baseline; remove takes back only keys the template still
// owns unchanged, so a person's edits always survive.
import { jsonEqual } from "../../contract/schema.ts";
import { DEFAULT_PARSE_LIMITS } from "../../contract/untrusted.ts";
import { ForgeFailure } from "../../contract/failure.ts";
import type {
  KeyOwner,
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
  removeIn,
  setIn,
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
  import(input: {
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

function refuse(message: string, repair?: string): ForgeFailure {
  return new ForgeFailure({
    code: "INPUT_INVALID",
    message,
    retry: "never",
    ...(repair === undefined ? {} : { repair }),
  });
}

function idOf(ref: string): string {
  const at = ref.lastIndexOf("@");
  return at === -1 ? ref : ref.slice(0, at);
}

function refOf(template: TemplateDocument): string {
  return `${template.id}@${template.version}`;
}

function provenance(document: JsonObject | undefined): TemplateProvenance[] {
  return Array.isArray(document?.templates)
    ? (document.templates as TemplateProvenance[])
    : [];
}

function owners(document: JsonObject): JsonObject {
  if (!isObject(document.owners)) document.owners = {};
  return document.owners as JsonObject;
}

function ownerOf(
  document: JsonObject | undefined,
  pointer: string,
): KeyOwner | undefined {
  const all = isObject(document?.owners) ? document.owners : {};
  const owner = all[pointer];
  return isObject(owner) &&
    typeof owner.from === "string" &&
    typeof owner.baseline === "string"
    ? { from: owner.from, baseline: owner.baseline }
    : undefined;
}

/** The template's keys: everything in its config except the schema version, a source kept whole. */
function templateLeaves(template: TemplateDocument): Map<string, unknown> {
  return new Map(
    leaves(template.config, atomicSource)
      .filter((l) => l.segments[0] !== "schemaVersion")
      .map((l) => [formatPointer(l.segments), l.value]),
  );
}

/** A value in the document overlaps the pointer (an ancestor that is not an object counts). */
function blocked(document: JsonObject, segments: readonly string[]): boolean {
  for (let depth = 1; depth < segments.length; depth += 1) {
    const ancestor = segments.slice(0, depth);
    if (hasIn(document, ancestor) && !isObject(getIn(document, ancestor)))
      return true;
  }
  return false;
}

export function createTemplates(env: TemplateEnvironment): TemplateApi {
  const load = (reference: string): TemplateDocument => {
    if (TEMPLATE_FILE.test(reference)) {
      const path = reference.replace(/^\.\//, "");
      if (!validateRelativePath(path).ok) {
        throw refuse(`${reference} is not a project-relative path`);
      }
      const bytes = env.files.read(path);
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

  const requireImported = (
    document: JsonObject | undefined,
    id: string,
  ): string => {
    const ref = importedRef(document, id);
    if (ref === undefined) {
      throw refuse(
        `${id} is not imported into ${CONFIG_FILE}`,
        "see imported templates with template list",
      );
    }
    return ref;
  };

  const compareKeys = (
    document: JsonObject,
    id: string,
    upstream: TemplateDocument,
  ): KeyChange[] => {
    const upstreamKeys = templateLeaves(upstream);
    const changes: KeyChange[] = [];
    for (const [pointer, value] of upstreamKeys) {
      const segments = parsePointer(pointer) ?? [];
      const owner = ownerOf(document, pointer);
      const present = hasIn(document, segments);
      const current = getIn(document, segments);
      const shown = present ? { current } : {};
      if (owner !== undefined && idOf(owner.from) === id) {
        if (digestValue(value) === owner.baseline) continue;
        const edited = !present || digestValue(current) !== owner.baseline;
        if (!edited)
          changes.push({ pointer, kind: "change", ...shown, upstream: value });
        else if (present && jsonEqual(current, value))
          changes.push({ pointer, kind: "adopt", ...shown, upstream: value });
        else
          changes.push({
            pointer,
            kind: "conflict",
            ...shown,
            upstream: value,
            reason: present ? "edited since import" : "removed since import",
          });
      } else if (!present && !blocked(document, segments)) {
        changes.push({ pointer, kind: "add", upstream: value });
      } else if (!present || !jsonEqual(current, value)) {
        changes.push({
          pointer,
          kind: "conflict",
          ...shown,
          upstream: value,
          reason: "already set in the project",
        });
      }
    }
    for (const [pointer, owner] of Object.entries(
      isObject(document.owners) ? document.owners : {},
    )) {
      if (
        !isObject(owner) ||
        idOf(String(owner.from)) !== id ||
        upstreamKeys.has(pointer)
      )
        continue;
      const segments = parsePointer(pointer) ?? [];
      if (!hasIn(document, segments)) continue;
      const current = getIn(document, segments);
      changes.push(
        digestValue(current) === owner.baseline
          ? { pointer, kind: "remove", current }
          : {
              pointer,
              kind: "kept",
              current,
              reason: "upstream dropped it, but it was edited since import",
            },
      );
    }
    return changes.sort((a, b) => a.pointer.localeCompare(b.pointer));
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

    import(input) {
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
          for (const [pointer, value] of templateLeaves(template)) {
            const segments = parsePointer(pointer) ?? [];
            const present = hasIn(document, segments);
            if (segments[0] === "blocks" && foreign.has(segments[1] ?? "")) {
              conflicts.push({
                pointer,
                kind: "conflict",
                ...(present ? { current: getIn(document, segments) } : {}),
                upstream: value,
                reason: `instance ${segments[1]} already comes from a different source`,
              });
            } else if (present) {
              const current = getIn(document, segments);
              if (jsonEqual(current, value)) shared.push(pointer);
              else
                conflicts.push({
                  pointer,
                  kind: "conflict",
                  current,
                  upstream: value,
                  reason: "already set in the project",
                });
            } else if (blocked(document, segments)) {
              conflicts.push({
                pointer,
                kind: "conflict",
                upstream: value,
                reason: "a value in the project covers this key",
              });
            } else {
              setIn(document, segments, clone(value));
              owners(document)[pointer] = {
                from: ref,
                baseline: digestValue(value),
              };
              added.push(pointer);
            }
          }
          document.templates = [
            ...provenance(document),
            { template: ref, digest: digestValue(template), importedAt: now() },
          ];
          return { added, shared, conflicts };
        },
      );
      const { detail, ...written } = result;
      return { ...written, template: ref, ...detail };
    },

    compare(input) {
      const current = readProject(env);
      const document = writable(current);
      const id = idOf(input.template);
      const imported = requireImported(document, id);
      const upstream = load(input.source ?? id);
      if (upstream.id !== id)
        throw refuse(`${input.source} holds ${upstream.id}, not ${id}`);
      return {
        template: id,
        imported,
        upstream: refOf(upstream),
        revision: current.revision,
        changes: compareKeys(document, id, upstream),
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
          requireImported(document, id);
          const applied: KeyChange[] = [];
          const conflicts: KeyChange[] = [];
          for (const change of compareKeys(document, id, upstream)) {
            const segments = parsePointer(change.pointer) ?? [];
            const take =
              change.kind === "conflict" && accept.has(change.pointer);
            if (change.kind === "conflict" && !take) {
              conflicts.push(change);
            } else if (change.kind === "kept") {
              delete owners(document)[change.pointer];
              conflicts.push(change);
            } else if (change.kind === "remove") {
              removeIn(document, segments);
              delete owners(document)[change.pointer];
              applied.push(change);
            } else {
              setIn(document, segments, clone(change.upstream));
              owners(document)[change.pointer] = {
                from: ref,
                baseline: digestValue(change.upstream),
              };
              applied.push(change);
            }
          }
          const all = owners(document);
          for (const [pointer, owner] of Object.entries(all)) {
            if (isObject(owner) && idOf(String(owner.from)) === id) {
              all[pointer] = { ...owner, from: ref };
            }
          }
          document.templates = provenance(document).map((p) =>
            idOf(p.template) === id
              ? {
                  template: ref,
                  digest: digestValue(upstream),
                  importedAt: now(),
                }
              : p,
          );
          return { applied, conflicts };
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
          ref = requireImported(document, id);
          const others = provenance(document).filter(
            (p) => idOf(p.template) !== id,
          );
          const otherKeys = others.map((p) => {
            const template = env.templates.get(idOf(p.template));
            return {
              ref: p.template,
              keys:
                template === undefined ? undefined : templateLeaves(template),
            };
          });
          const all = owners(document);
          const removing: string[] = [];
          const kept: KeyChange[] = [];
          for (const [pointer, owner] of Object.entries(all)) {
            if (!isObject(owner) || idOf(String(owner.from)) !== id) continue;
            const segments = parsePointer(pointer) ?? [];
            delete all[pointer];
            if (!hasIn(document, segments)) continue;
            const current = getIn(document, segments);
            if (digestValue(current) !== owner.baseline) {
              kept.push({
                pointer,
                kind: "kept",
                current,
                reason: "edited since import; it is yours now",
              });
              continue;
            }
            const sharer = otherKeys.find(
              (o) =>
                o.keys !== undefined &&
                o.keys.has(pointer) &&
                jsonEqual(o.keys.get(pointer), current),
            );
            if (sharer !== undefined) {
              all[pointer] = {
                from: sharer.ref,
                baseline: digestValue(current),
              };
              kept.push({
                pointer,
                kind: "kept",
                current,
                reason: `${sharer.ref} sets the same value`,
              });
              continue;
            }
            const unknown = otherKeys.find((o) => o.keys === undefined);
            if (unknown !== undefined) {
              kept.push({
                pointer,
                kind: "kept",
                current,
                reason: `${unknown.ref} is not installed here, so whether it shares this key is unknown`,
              });
              continue;
            }
            removing.push(pointer);
          }
          // a source stays while anything else of its instance stays
          const removed: string[] = [];
          const removingSet = new Set(removing);
          for (const pointer of removing) {
            const segments = parsePointer(pointer) ?? [];
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
                kept.push({
                  pointer,
                  kind: "kept",
                  current: getIn(document, segments),
                  reason:
                    "other keys of this instance stay, so its source stays",
                });
                continue;
              }
            }
            removed.push(pointer);
          }
          for (const pointer of removed)
            removeIn(document, parsePointer(pointer) ?? []);
          if (Object.keys(all).length === 0) delete document.owners;
          const rest = provenance(document).filter(
            (p) => idOf(p.template) !== id,
          );
          if (rest.length === 0) delete document.templates;
          else document.templates = rest;
          return {
            removed,
            kept: kept.sort((a, b) => a.pointer.localeCompare(b.pointer)),
          };
        },
      );
      const { detail, ...written } = result;
      return { ...written, template: ref, ...detail };
    },
  };
}
