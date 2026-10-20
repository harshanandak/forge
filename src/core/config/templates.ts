// template.* operations. Importing copies a template's config keys into the project as plain,
// editable config, and records each key it wrote with the digest of the value it wrote. There is
// no merge: a key the project already sets to a different value refuses the whole import, naming
// the keys. Removing a template removes exactly the keys it wrote that still hold that value; the
// rest stay and are reported. To diff, revert or blame a config file, use version control.
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
import {
  clone,
  digestValue,
  formatPointer,
  getIn,
  hasIn,
  isObject,
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
  /** Keys the project already set to the same value; left as they were and not recorded. */
  readonly shared: readonly string[];
}

export interface KeptKey {
  readonly pointer: string;
  readonly reason: string;
}

export interface RemoveResult extends WriteResult {
  readonly template: string;
  readonly removed: readonly string[];
  /** Keys the template wrote that stay: edited since import, or still needed by their instance. */
  readonly kept: readonly KeptKey[];
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

/** Owner records of template `id`: pointer → digest of the value it wrote. */
function ownedBy(
  document: JsonObject | undefined,
  id: string,
): [string, string][] {
  const all = isObject(document?.owners) ? document.owners : {};
  return Object.entries(all).flatMap(([pointer, owner]) =>
    isObject(owner) &&
    typeof owner.from === "string" &&
    typeof owner.baseline === "string" &&
    idOf(owner.from) === id
      ? [[pointer, owner.baseline] as [string, string]]
      : [],
  );
}

/** Template payloads contain only config values; Forge alone writes provenance. */
function templateLeaves(template: TemplateDocument): Map<string, unknown> {
  return new Map(
    leaves(template.config, atomicSource)
      .filter((l) => !METADATA_KEYS.includes(l.segments[0] ?? ""))
      .map((l) => [formatPointer(l.segments), l.value]),
  );
}

/** True when the project sets a value at the key or at an ancestor that is not an object. */
function occupied(document: JsonObject, segments: readonly string[]): boolean {
  for (let depth = 1; depth < segments.length; depth += 1) {
    const ancestor = segments.slice(0, depth);
    if (hasIn(document, ancestor) && !isObject(getIn(document, ancestor)))
      return true;
  }
  return hasIn(document, segments);
}

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
      if (
        isObject(document.owners) &&
        Object.keys(document.owners).length === 0
      )
        delete document.owners;
      const planned = planBytes(env, current, document);
      changes = planned.changes;
      return { bytes: planned.bytes };
    });
    return {
      file: CONFIG_FILE,
      previousRevision: committed.from,
      revision: committed.to,
      changes: committed.changed ? changes : [],
      fileRemoved: committed.fileRemoved,
      detail: detail as T,
    };
  };

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
      const template = TEMPLATE_FILE.test(input.template)
        ? load(input.template)
        : (env.templates.get(idOf(input.template)) ?? null);
      const id = template?.id ?? idOf(input.template);
      return {
        template,
        imported:
          provenance(document).find((p) => idOf(p.template) === id) ?? null,
        owned: ownedBy(document, id).map(([pointer, baseline]) => {
          const segments = parsePointer(pointer) ?? [];
          return {
            pointer,
            edited:
              !hasIn(document, segments) ||
              digestValue(getIn(document, segments)) !== baseline,
          };
        }),
      };
    },

    importTemplate(input) {
      const template = load(input.template);
      const ref = refOf(template);
      const { detail, ...written } = editWith(
        "template.import",
        input.expectRevision,
        (document) => {
          const already = importedRef(document, template.id);
          if (already !== undefined) {
            throw new ForgeFailure({
              code: "INPUT_CONFLICT",
              message: `${already} is already imported`,
              retry: "never",
              repair: `remove it with template remove ${template.id}, then import again`,
            });
          }
          const added: string[] = [];
          const shared: string[] = [];
          const conflicts: string[] = [];
          for (const [pointer, value] of templateLeaves(template)) {
            const segments = parsePointer(pointer) ?? [];
            if (!occupied(document, segments)) added.push(pointer);
            else if (jsonEqual(getIn(document, segments), value))
              shared.push(pointer);
            else conflicts.push(pointer);
          }
          if (conflicts.length > 0) {
            throw new ForgeFailure({
              code: "INPUT_CONFLICT",
              message: `${ref} sets keys ${CONFIG_FILE} already sets to a different value: ${conflicts.sort().join(", ")}`,
              retry: "never",
              repair:
                "remove or change those keys with config set or config apply, then import again",
            });
          }
          const values = templateLeaves(template);
          const records = owners(document);
          for (const pointer of added) {
            const value = values.get(pointer);
            setIn(document, parsePointer(pointer) ?? [], clone(value));
            records[pointer] = { from: ref, baseline: digestValue(value) };
          }
          document.templates = [
            ...provenance(document),
            {
              template: ref,
              digest: digestValue(template),
              importedAt: new Date(env.clock.now()).toISOString(),
            },
          ];
          return { added: added.sort(), shared: shared.sort() };
        },
      );
      return { ...written, template: ref, ...detail };
    },

    remove(input) {
      const id = idOf(input.template);
      let ref = id;
      const { detail, ...written } = editWith(
        "template.remove",
        input.expectRevision,
        (document) => {
          ref = requireImported(document, input.template);
          const removed: string[] = [];
          const kept: KeptKey[] = [];
          const sources: string[] = [];
          const records = owners(document);
          for (const [pointer, baseline] of ownedBy(document, id)) {
            delete records[pointer];
            const segments = parsePointer(pointer) ?? [];
            if (!hasIn(document, segments)) continue;
            if (digestValue(getIn(document, segments)) !== baseline)
              kept.push({ pointer, reason: "edited since import" });
            else if (atomicSource(segments)) sources.push(pointer);
            else {
              removeIn(document, segments);
              removed.push(pointer);
            }
          }
          // an instance cannot lose its source while other keys of it stay
          for (const pointer of sources) {
            const segments = parsePointer(pointer) ?? [];
            const instance = getIn(document, segments.slice(0, 2));
            if (isObject(instance) && Object.keys(instance).length > 1)
              kept.push({
                pointer,
                reason: "other keys of this instance stay, so its source stays",
              });
            else {
              removeIn(document, segments);
              removed.push(pointer);
            }
          }
          const rest = provenance(document).filter(
            (p) => idOf(p.template) !== id,
          );
          if (rest.length === 0) delete document.templates;
          else document.templates = rest;
          return {
            removed: removed.sort(),
            kept: kept.sort((a, b) => a.pointer.localeCompare(b.pointer)),
          };
        },
      );
      return { ...written, template: ref, ...detail };
    },
  };
}
