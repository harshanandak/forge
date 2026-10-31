// forge/memory: project and device knowledge. One self-contained file: no imports at run time, no
// files, only the bound state clients.
//
// Notes live at one of two levels. Device notes are in the device store and are visible from every
// project on the device. Project notes are in the caller's project store and are visible only inside
// that project; another project reads them only by naming the project, and gets them read-only.
// A note's id carries its level and origin (device/note-3, project/<project id>/note-3), so the
// same number at two levels never names the same note. Decisions live in the project store.
import type {
  BatchEntry,
  ExtendedStateClient,
  StateClient,
  StateRecord,
} from "../../contract/author.ts";
import type {
  PeerLookup,
  ProjectIdentity,
  StoreLevels,
} from "../../assembly/levels.ts";

declare const fail: (code: string, message: string) => never;

type Level = "device" | "project";
interface Services {
  /** The store of the operation's declared context: the device's, or the project's for decisions. */
  readonly state: ExtendedStateClient;
  /** The declared forge.project-state@1 slot: this host's project, and other projects read-only. */
  readonly levels: StoreLevels;
}
interface Untrusted {
  kind: "untrusted";
  source: string;
  receivedAt?: string;
  text: string;
}
interface Version {
  readonly revision: number;
  readonly text: string;
  readonly at?: string | undefined;
  readonly approval?: Approval & { readonly at: string };
}
interface NoteValue {
  readonly text: string;
  readonly createdAt?: string;
  readonly createdAtApprox?: true;
  readonly changedAt?: string;
  readonly textAt?: string;
  readonly versionApproval?: Approval & { readonly at: string };
  readonly scope?: string;
  readonly tags: readonly string[];
  readonly links: readonly string[];
  readonly previous: readonly Version[];
  /** Metadata writes keep the current text's original revision without consuming retention. */
  readonly textRevision?: number;
  /** The note this one was moved or copied from: the transfer's identity. */
  readonly from?: string;
  readonly deleted?: true;
  /** A request for the owner to forget this note; the note remains readable. */
  readonly proposedForget?: true;
  /** On a moved note's tombstone: where it went. */
  readonly movedTo?: string;
  /** Forget keeps recovery data private; readers never present this value. */
  readonly forgotten?: NoteValue;
  readonly approval?: Approval & { readonly at: string };
}
type Approval =
  | { readonly by: "owner"; readonly quote: string }
  | { readonly by: "agent"; readonly reason: string };
interface NoteFields {
  readonly text: string;
  /** On an edit, null clears the scope and absent keeps it. */
  readonly scope?: string | null;
  readonly tags?: readonly string[];
  readonly links?: readonly string[];
}
interface DecisionValue {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly text: string;
  readonly consequences?: string;
  readonly status: "proposed" | "adopted";
  readonly proposedAt?: string;
  readonly approval?: Approval & { readonly at: string };
}
interface DecisionFormat {
  readonly idPattern?: string;
  readonly highest?: number;
  readonly layout?: "file-per-record" | "single-file";
  readonly path?: string;
}
/** What a caller gets when it does not say a level: refused, or a level chosen for it. */
type LevelDefault = "required" | "nearest" | "project" | "device";
interface MemoryConfig {
  readonly scope?: string;
  readonly decisions?: DecisionFormat;
  readonly approval?: {
    readonly ownerTags?: readonly string[];
    readonly adopt?: "owner" | "agent";
  };
  readonly levels?: {
    readonly human?: LevelDefault;
    readonly agent?: LevelDefault;
  };
}
/** What a destination records about a transfer into it. */
interface Transfer {
  readonly number: number;
  /** The copy's revision when the transfer wrote it. */
  readonly revision: number;
  /** The source revision the copy was taken from. */
  readonly sourceRevision: number;
}
type Origin =
  | { readonly level: "device" }
  | { readonly level: "project"; readonly project: ProjectIdentity };
/** One store of notes, with where it is and whether this call may change it. */
interface Source {
  readonly level: Level;
  readonly origin: Origin;
  /** The id prefix: device, or project/<project id>. */
  readonly prefix: string;
  readonly state: ExtendedStateClient;
  readonly readOnly: boolean;
}

// Keys carry zero-padded numbers, so key order is number order and a range of keys is a range of
// numbers. Every call reads one page of that range, never the whole store.
const NOTE_PREFIX = "note/";
const NOTE_END = "note/\u{10FFFF}";
const NOTE_COUNTER = "meta/note-counter";
const TRANSFER_PREFIX = "transfer/";
const DECISION_PREFIX = "decision/";
const DECISION_END = "decision/\u{10FFFF}";
const DECISION_ID_PREFIX = "decision-id/";
const DECISION_COUNTER = "meta/decision-counter";
const SEARCH_WINDOW = 1000;
const EXPORT_READ = 100;
// The runtime stops a block after one second and refuses output over 1 MiB. A write costs a few
// milliseconds and one operation is one commit, so a restore takes few notes; an export chunk is
// never larger than a restore.
const CHUNK_NOTES = 25;
const CHUNK_CHARS = 250_000;
const LIST_LIMIT = 200;
const MAX_VERSIONS = 5;
const MAX_RETRIES = 8;
const DEFAULT_LIMIT = 10;
const SNIPPET_LENGTH = 200;
// A bare note-N is a note written before notes had levels: every one of those is a device note.
const NOTE_REF = /^(?:(device|project\/([0-9a-f]{16}))\/)?note-([0-9]{1,9})$/;
const LEGACY_REF = /^note-[0-9]{1,9}$/;
const STOPWORDS = new Set(
  "a an and are as at be but by do does for from how i if in is it its my of on or our so that the their then there these they this to was we were what when where which who why will with you your".split(
    " ",
  ),
);

/** Neutralise the delimiters of the earlier text fence so quoted text cannot forge one. */
function neutralize(text: string): string {
  return text.split("⟦").join("(").split("⟧").join(")");
}
/** Everything a note or decision says was written by someone else, so it is returned as data. */
function fence(text: string, source: string, receivedAt?: string): Untrusted {
  const fenced: Untrusted = {
    kind: "untrusted",
    source,
    text: neutralize(text),
  };
  if (receivedAt !== undefined) fenced.receivedAt = receivedAt;
  return fenced;
}
function ownerTag(
  tags: readonly string[],
  config: MemoryConfig,
): string | undefined {
  return tags.find((tag) =>
    (config.approval?.ownerTags ?? ["rule", "preference", "decision"]).includes(
      tag,
    ),
  );
}
function approved(
  approval: Approval | undefined,
  operation: string,
  rule?: string,
): Approval & { at: string } {
  if (!approval || (rule !== undefined && approval.by !== "owner"))
    fail(
      "HUMAN_REQUIRED",
      `${operation} requires approval${rule === undefined ? "" : ` by owner for ${rule}`}. Ask the owner in the conversation, then retry with approval by owner and their words.`,
    );
  return { ...approval, at: new Date().toISOString() };
}
function audit(approval: NoteValue["approval"], source: string) {
  return approval === undefined
    ? {}
    : {
        approval: {
          by: approval.by,
          at: approval.at,
          ...(approval.by === "owner"
            ? { quote: fence(approval.quote, `${source}:approval`) }
            : { reason: fence(approval.reason, `${source}:approval`) }),
        },
      };
}

function conflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const detail = (error as { error?: { code?: unknown } }).error;
  return detail?.code === "REVISION_CONFLICT";
}
/** The counter's last issued number and the revision to write it at. */
function readCounter(
  state: StateClient,
  key: string,
): { last: number; revision: number } {
  const current = state.get(key);
  return {
    last: current ? (current.value as { last: number }).last : 0,
    revision: current?.revision ?? 0,
  };
}
/**
 * Run a read-then-write that commits as one transaction. A competing writer that wins makes it
 * start again from fresh reads. Every write the block makes to one store is one such transaction,
 * so one operation costs one durable commit per store however many records it touches.
 */
function committed<T>(attempt: () => T): T {
  let last: unknown;
  for (let attempts = 0; attempts < MAX_RETRIES; attempts += 1) {
    try {
      return attempt();
    } catch (error) {
      if (!conflict(error)) throw error;
      last = error;
    }
  }
  throw last;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

function numberKey(prefix: string, number: number): string {
  return `${prefix}${String(number).padStart(9, "0")}`;
}
function noteKey(number: number): string {
  return numberKey(NOTE_PREFIX, number);
}
function numberOf(record: StateRecord): number {
  return Number(record.key.slice(NOTE_PREFIX.length));
}
function idIn(source: Source, number: number): string {
  return `${source.prefix}/note-${number}`;
}
/**
 * The one place an id from before levels is read: a bare note-N, stored in a link or given as
 * input, is the device note of that number. Everything the block returns or writes is qualified.
 */
function qualified(id: string): string {
  return LEGACY_REF.test(id) ? `device/${id}` : id;
}
function qualifiedLinks(links: readonly string[]): string[] {
  return [...new Set(links.map(qualified))];
}
/** A note id split into where it lives and its number. */
function parseRef(
  id: string,
): { level: Level; project?: string; number: number } | undefined {
  const match = NOTE_REF.exec(id);
  if (!match) return undefined;
  return match[2] === undefined
    ? { level: "device", number: Number(match[3]) }
    : { level: "project", project: match[2], number: Number(match[3]) };
}

function deviceSource(state: ExtendedStateClient): Source {
  return {
    level: "device",
    origin: { level: "device" },
    prefix: "device",
    state,
    readOnly: false,
  };
}
function projectSource(
  identity: ProjectIdentity,
  state: ExtendedStateClient,
  readOnly: boolean,
): Source {
  return {
    level: "project",
    origin: {
      level: "project",
      project: { id: identity.id, name: identity.name },
    },
    prefix: `project/${identity.id}`,
    state,
    readOnly,
  };
}
/** The caller's own project, or undefined when it has none (or, on a read, no notes yet). */
async function ownProject(services: Services): Promise<Source | undefined> {
  const own = await services.levels.project();
  return own && projectSource(own.identity, own.state, false);
}
type Unreached =
  | { readonly ref: string; readonly status: "not_found" }
  | {
      readonly ref: string;
      readonly status: "unavailable";
      readonly project: ProjectIdentity;
    }
  | {
      readonly ref: string;
      readonly status: "ambiguous";
      readonly candidates: readonly ProjectIdentity[];
    };
/** Another project's notes, read-only: only ever reached because the caller named that project. */
async function pulled(
  services: Services,
  ref: string,
): Promise<Source | Unreached> {
  const found: PeerLookup = await services.levels.peer(ref);
  switch (found.status) {
    case "found":
      return projectSource(found.identity, found.state, true);
    case "not_found":
      return { ref, status: "not_found" };
    case "unavailable":
      return {
        ref,
        status: "unavailable",
        project: { id: found.identity.id, name: found.identity.name },
      };
    case "ambiguous":
      return {
        ref,
        status: "ambiguous",
        candidates: found.candidates.map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
        })),
      };
  }
}
function isSource(value: Source | Unreached): value is Source {
  return "prefix" in value;
}
/** The store a note id names: the device, the caller's project, or (read-only) another project. */
async function sourceFor(
  services: Services,
  id: string,
): Promise<{ source: Source; number: number } | Unreached> {
  const ref = parseRef(id);
  if (!ref) return { ref: id, status: "not_found" };
  if (ref.level === "device")
    return { source: deviceSource(services.state), number: ref.number };
  const own = services.levels.inProject
    ? await ownProject(services)
    : undefined;
  if (
    own &&
    own.origin.level === "project" &&
    own.origin.project.id === ref.project
  )
    return { source: own, number: ref.number };
  const other = await pulled(services, ref.project!);
  return isSource(other) ? { source: other, number: ref.number } : other;
}
function unreached(found: object): found is Unreached {
  return "status" in found;
}
/** The store for a level this call writes to; a project level needs a project in the request. */
async function writeTarget(services: Services, level: Level): Promise<Source> {
  if (level === "device") return deviceSource(services.state);
  if (!services.levels.inProject)
    fail(
      "LEVEL_UNAVAILABLE",
      'This host serves no project, so it cannot use level "project". Use level "device", or call from a host inside a project.',
    );
  const own = await ownProject(services);
  if (!own) fail("LEVEL_UNAVAILABLE", "The project store did not open");
  return own;
}
/** The level a new note goes to: the caller's own word, else the configured default for its kind. */
function chooseLevel(
  requested: Level | undefined,
  config: MemoryConfig,
  services: Services,
): Level {
  if (requested !== undefined) return requested;
  const policy = config.levels?.[services.levels.caller] ?? "required";
  if (policy === "device" || policy === "project") return policy;
  if (policy === "nearest")
    return services.levels.inProject ? "project" : "device";
  return fail(
    "LEVEL_REQUIRED",
    'Say which level this note belongs to: level "device" (this device, visible from every project) or level "project" (this project only).',
  );
}

function noteOf(
  source: Source,
  record: StateRecord,
): { id: string; number: number; value: NoteValue; record: StateRecord } {
  const number = numberOf(record);
  return {
    id: idIn(source, number),
    number,
    value: record.value as NoteValue,
    record,
  };
}
/**
 * One page of note records (tombstones included) from a range of note numbers. At most `limit`
 * records are read from the store, whatever the store holds.
 */
function notePage(
  source: Source,
  options: {
    readonly after?: number;
    readonly before?: number;
    readonly limit: number;
    readonly descending: boolean;
  },
): { id: string; number: number; value: NoteValue; record: StateRecord }[] {
  return source.state
    .listRange({
      from: noteKey((options.after ?? 0) + 1),
      to: options.before === undefined ? NOTE_END : noteKey(options.before),
      limit: options.limit,
      descending: options.descending,
    })
    .map((record) => noteOf(source, record));
}
/** Where a note lives, as every response labels it. */
function label(source: Source) {
  return {
    level: source.level,
    origin: source.origin,
    ...(source.readOnly ? { readOnly: true as const } : {}),
  };
}
/**
 * The versions a reader can ask for: the current one and each earlier text still kept, from the
 * note's own record, so a response never waits on the event log.
 */
function versionsOf(
  record: StateRecord,
  value: NoteValue,
): Omit<Version, "text">[] {
  return [
    ...value.previous,
    {
      revision: value.textRevision ?? record.revision,
      at:
        value.textAt ??
        (value.textRevision === undefined ? record.updatedAt : undefined),
      ...(value.versionApproval ? { approval: value.versionApproval } : {}),
    },
  ];
}
function present(
  source: Source,
  id: string,
  record: StateRecord,
  value: NoteValue,
  text: string,
  versions = shown(source.state, record, value),
) {
  return {
    id,
    ...label(source),
    revision: record.revision,
    ...(value.scope === undefined ? {} : { scope: value.scope }),
    tags: [...value.tags],
    links: qualifiedLinks(value.links),
    ...(value.from === undefined ? {} : { from: value.from }),
    ...(value.proposedForget === true ? { proposedForget: true as const } : {}),
    text: fence(text, `memory:${id}`, record.updatedAt),
    updatedAt: record.updatedAt,
    ...dates(source.state, record, value),
    versions,
    ...audit(value.approval, `memory:${id}`),
  };
}

/** Legacy versions lack durable times; each missing stamp uses one indexed history lookup. */
function shown(
  state: ExtendedStateClient,
  record: StateRecord,
  value: NoteValue,
) {
  return versionsOf(record, value).map(({ revision, at, approval }) => {
    const event =
      at === undefined
        ? state.history({ key: record.key, before: revision + 1, limit: 1 })[0]
        : undefined;
    return {
      revision,
      at: at ?? (event?.revision === revision ? event.at : record.updatedAt),
      ...audit(approval, `memory:${record.key}:version-${revision}`),
    };
  });
}
function dates(
  state: ExtendedStateClient,
  record: StateRecord,
  value: NoteValue,
) {
  return {
    createdAt:
      value.createdAt ?? shown(state, record, value)[0]?.at ?? record.updatedAt,
    ...(value.createdAt === undefined || value.createdAtApprox
      ? { createdAtApprox: true as const }
      : {}),
  };
}
function contentTime(
  state: ExtendedStateClient,
  record: StateRecord,
  value: NoteValue,
) {
  if (value.changedAt !== undefined) return value.changedAt;
  let changed = dates(state, record, value).createdAt;
  let previous: string | undefined;
  for (const { revision } of versionsOf(record, value)) {
    const event = state.history({
      key: record.key,
      before: revision + 1,
      limit: 1,
    })[0];
    const snapshot = event?.data as NoteValue | undefined;
    if (event?.revision !== revision || !snapshot) continue;
    const content = canonical([snapshot.text, snapshot.tags, snapshot.scope]);
    if (previous !== undefined && content !== previous) changed = event.at;
    previous = content;
  }
  return changed;
}
function terms(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 1 && !STOPWORDS.has(term));
}
function stem(term: string): string {
  return term.length > 3 && term.endsWith("s") ? term.slice(0, -1) : term;
}
function snippet(text: string, query: readonly string[]): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of query) {
    const found = lower.indexOf(term);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  const start = Math.max(0, at - 40);
  const cut = text.slice(start, start + SNIPPET_LENGTH);
  return `${start > 0 ? "…" : ""}${cut}${start + SNIPPET_LENGTH < text.length ? "…" : ""}`;
}

function slug(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return words.slice(0, 60).replace(/-+$/g, "") || "decision";
}
function formatId(pattern: string, number: number): string {
  const first = pattern.indexOf("N");
  const width = pattern.length - first;
  return pattern.slice(0, first) + String(number).padStart(width, "0");
}
function decisionOf(record: StateRecord): DecisionValue {
  return record.value as DecisionValue;
}
function decisionText(value: DecisionValue, status: string): string {
  return [
    `${value.id}: ${value.title}`,
    "",
    `Status: ${status}`,
    "",
    value.text,
    ...(value.consequences === undefined
      ? []
      : ["", "Consequences", "", value.consequences]),
    "",
  ].join("\n");
}
const TOMBSTONE = {
  text: "",
  tags: [],
  links: [],
  previous: [],
  deleted: true,
} as const;

function resolvedScope(config: MemoryConfig, services: Services): string {
  return (
    (services.levels.inProject ? config.scope : undefined) ??
    services.levels.defaultScope ??
    "general"
  );
}

module.exports = {
  "memory.scope": ({
    config = {},
    services,
  }: {
    config?: MemoryConfig;
    services: Services;
  }) => ({
    scope: resolvedScope(config, services),
  }),
  "memory.rules": async ({
    input = {},
    config = {},
    services,
  }: {
    input?: { notes?: boolean };
    config?: MemoryConfig;
    services: Services;
  }) => {
    const sources = [deviceSource(services.state)];
    const project = services.levels.inProject
      ? await ownProject(services)
      : undefined;
    if (project) sources.push(project);
    const scope = resolvedScope(config, services);
    const counts = new Map<string, number>([["general", 0]]);
    counts.set(scope, 0);
    const rules: {
      scope: string;
      text: string;
      at: string;
      id: string;
      revision: number;
      updated: string;
      source: number;
      number: number;
    }[] = [];
    for (const [sourceIndex, source] of sources.entries()) {
      let after = 0;
      for (;;) {
        const records = notePage(source, {
          after,
          limit: LIST_LIMIT,
          descending: false,
        });
        for (const note of records) {
          const value = note.value as Partial<NoteValue> | null;
          if (
            !value ||
            typeof value.text !== "string" ||
            value.deleted === true
          )
            continue;
          const noteScope =
            value.scope ??
            (source.level === "project" ? scope : undefined) ??
            "general";
          const count = counts.get(noteScope);
          if (count !== undefined) counts.set(noteScope, count + 1);
          if (
            count !== undefined &&
            input.notes &&
            value.tags?.includes("rule")
          )
            rules.push({
              scope: noteScope,
              text: value.text,
              at: dates(source.state, note.record, note.value).createdAt,
              id: note.id,
              revision: note.record.revision,
              updated: contentTime(source.state, note.record, note.value),
              source: sourceIndex,
              number: note.number,
            });
        }
        const last = records.at(-1);
        if (records.length < LIST_LIMIT || !last) break;
        after = last.number;
      }
    }
    const text = [
      "Forge memory notes: " +
        [...counts].map(([name, count]) => name + " " + count).join(", ") +
        ".",
      "Before a task, search memory for its topic; prefer hits scoped " +
        (scope === "general" ? "general" : scope + " or general") +
        ".",
      'forge memory search "<topic>"',
      "forge memory show <id>",
    ].join("\n");
    const lines: string[] = [];
    const selected: { id: string; revision: number; scope: string }[] = [];
    const omitted: {
      id: string;
      revision: number;
      scope: string;
      reason: "over-cap";
    }[] = [];
    let used = 0;
    let omittedCount = 0;
    rules.sort(
      (a, b) =>
        Number(b.scope === "general") - Number(a.scope === "general") ||
        a.at.localeCompare(b.at) ||
        a.source - b.source ||
        a.number - b.number,
    );
    for (const rule of rules) {
      const identity = {
        id: rule.id,
        revision: rule.revision,
        scope: rule.scope,
      };
      const note = rule.text.replace(/[\s\u0085]+/gu, " ").trim();
      const line = `- [${rule.scope}] ${rule.id} (created ${rule.at.slice(0, 10)}${rule.updated === rule.at ? "" : `, updated ${rule.updated.slice(0, 10)}`}) ${note}`;
      const size = line.length + (lines.length ? 1 : 0);
      if (used + size > 6000) {
        omittedCount++;
        if (omitted.length < 50)
          omitted.push({ ...identity, reason: "over-cap" });
        continue;
      }
      used += size;
      lines.push(line);
      selected.push(identity);
    }
    if (omittedCount)
      lines.push(`${omittedCount} more rule notes did not fit; search them.`);
    const packet = fence([...lines, text].join("\n"), "memory:rules");
    let utf8Bytes = 0;
    let characters = 0;
    // The block VM has no encoder; string iteration yields code points, including lone surrogates
    // which UTF-8 encodes as the three-byte replacement character.
    for (const character of packet.text) {
      const point = character.codePointAt(0)!;
      utf8Bytes +=
        point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
      characters++;
    }
    return {
      text: packet,
      receipt: {
        selected,
        omitted,
        omittedCount,
        packet: { utf8Bytes, characters, characterUnit: "Unicode code points" },
        cap: {
          limit: 6000,
          used,
          unit: "UTF-16 code units",
          includes: "accepted rule lines and newline separators",
          excludes: "omission line and pointer",
        },
        warnings: Array.from(
          services.levels.warnings ?? [],
          ({ code, message }) => ({ code, message }),
        ),
      },
    };
  },

  "memory.attach": async ({
    input = {},
    config = {},
    services,
  }: {
    input?: {
      ids?: string[];
      labels?: string[];
      paths?: string[];
      seen?: { id: string; revision: number }[];
    };
    config?: MemoryConfig;
    services: Services;
  }) => {
    const measure = (text: string) => {
      let utf8Bytes = 0;
      let characters = 0;
      for (const character of text) {
        const point = character.codePointAt(0)!;
        utf8Bytes +=
          point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
        characters++;
      }
      return { utf8Bytes, characters, characterUnit: "Unicode code points" };
    };
    const ids = new Map([...new Set(input.ids ?? [])].map((id, i) => [id, i]));
    const words = new Set(
      [
        ...(input.labels ?? []),
        ...(input.paths ?? []).flatMap((path) => path.split(/[\\/.]/u)),
      ]
        .filter(Boolean)
        .map((word) => word.toLowerCase()),
    );
    const seen = new Set(
      (input.seen ?? []).map((note) => `${note.id}@${note.revision}`),
    );
    const sources = [deviceSource(services.state)];
    const project = services.levels.inProject
      ? await ownProject(services)
      : undefined;
    if (project) sources.push(project);
    const scope = resolvedScope(config, services);
    type Selection = {
      id: string;
      revision: number;
      scope: string;
      reasons: string[];
    };
    const candidates: (Selection & {
      line: string;
      number: number;
      source: number;
    })[] = [];
    for (const [sourceIndex, source] of sources.entries()) {
      let after = 0;
      for (;;) {
        const records = notePage(source, {
          after,
          limit: LIST_LIMIT,
          descending: false,
        });
        for (const note of records) {
          const value = note.value as Partial<NoteValue> | null;
          if (
            !value ||
            typeof value.text !== "string" ||
            value.deleted === true
          )
            continue;
          const noteScope =
            value.scope ?? (source.level === "project" ? scope : "general");
          if (noteScope !== "general" && noteScope !== scope) continue;
          const reasons = [
            ...(ids.has(note.id) ? ["asked"] : []),
            ...(value.tags ?? []).filter(
              (tag) =>
                tag.toLowerCase().startsWith("on:") &&
                words.has(tag.slice(3).toLowerCase()),
            ),
          ];
          if (!reasons.length) continue;
          const at = dates(source.state, note.record, note.value).createdAt;
          const updated = contentTime(source.state, note.record, note.value);
          const text = value.text.replace(/[\s\u0085]+/gu, " ").trim();
          const line = `- [${noteScope}] ${note.id} (created ${at.slice(0, 10)}${updated === at ? "" : `, updated ${updated.slice(0, 10)}`}) ${text}`;
          candidates.push({
            id: note.id,
            revision: note.record.revision,
            scope: noteScope,
            reasons,
            line,
            number: note.number,
            source: sourceIndex,
          });
        }
        const last = records.at(-1);
        if (records.length < LIST_LIMIT || !last) break;
        after = last.number;
      }
    }
    candidates.sort(
      (a, b) =>
        (ids.get(a.id) ?? Infinity) - (ids.get(b.id) ?? Infinity) ||
        Number(b.scope === "general") - Number(a.scope === "general") ||
        a.number - b.number ||
        a.source - b.source,
    );
    const selected: Selection[] = [];
    const omitted: (Omit<Selection, "reasons"> & {
      reason: "seen" | "over-budget" | "response-limit";
    })[] = [];
    let omittedCount = 0;
    const omit = (
      note: (typeof candidates)[number],
      reason: (typeof omitted)[number]["reason"],
    ) => {
      omittedCount++;
      if (omitted.length < 50)
        omitted.push({
          id: note.id,
          revision: note.revision,
          scope: note.scope,
          reason,
        });
    };
    const warnings = Array.from(
      services.levels.warnings ?? [],
      ({ code, message }) => ({ code, message }),
    );
    const lines: string[] = [];
    let used = 0;
    let responseUsed = 0;
    let responseOmissions = 0;
    let oversized: string | undefined;
    // 128 KiB of JSON-encoded lines and selections leaves room for 50 omissions and warnings.
    // Even an 8000-character add note made entirely of JSON escapes fits on its own.
    const responseLimit = 131072;
    for (const note of candidates) {
      const identity = {
        id: note.id,
        revision: note.revision,
        scope: note.scope,
      };
      if (seen.has(`${note.id}@${note.revision}`)) {
        omit(note, "seen");
        continue;
      }
      const line = fence(note.line, "memory:attach").text;
      const size = measure(line).utf8Bytes + (lines.length ? 1 : 0);
      if (used + size > 4096 && !ids.has(note.id)) {
        omit(note, "over-budget");
        continue;
      }
      const overBudget =
        used + size > 4096 && ids.has(note.id)
          ? {
              code: "ATTACH_OVER_BUDGET",
              message: `Asked note ${note.id} exceeds the 4096 UTF-8 byte budget (${used + size} bytes used).`,
            }
          : undefined;
      const responseSize = measure(
        JSON.stringify([
          line,
          { ...identity, reasons: note.reasons },
          overBudget,
        ]),
      ).utf8Bytes;
      if (responseUsed + responseSize > responseLimit) {
        omit(note, "response-limit");
        if (ids.has(note.id)) responseOmissions++;
        if (responseSize > responseLimit) oversized ??= note.id;
        continue;
      }
      if (overBudget) warnings.push(overBudget);
      used += size;
      responseUsed += responseSize;
      lines.push(line);
      selected.push({ ...identity, reasons: note.reasons });
    }
    if (responseOmissions)
      warnings.push({
        code: "ATTACH_RESPONSE_LIMIT",
        message: `${responseOmissions} asked note${responseOmissions === 1 ? "" : "s"} exceeded the response limit; request them again in another call.${oversized ? ` Read an individually oversized note in full with forge memory show ${oversized}.` : ""}`,
      });
    const packet = fence(lines.join("\n"), "memory:attach");
    return {
      text: packet,
      receipt: {
        selected,
        omitted,
        omittedCount,
        packet: measure(packet.text),
        cap: {
          limit: 4096,
          used,
          unit: "UTF-8 bytes",
          includes: "accepted note lines and newline separators",
          excludes: "receipt",
        },
        warnings,
      },
    };
  },

  "memory.add": async ({
    input,
    config = {},
    services,
  }: {
    input: NoteFields & {
      id?: string;
      level?: Level;
      expectRevision?: number;
      approval?: Approval;
    };
    config?: MemoryConfig;
    services: Services;
  }) => {
    // An edit is a partial update: a field left out keeps its stored value, and clearing is said
    // outright (null for the scope, an empty list for tags or links). A new note has nothing to keep.
    const at = new Date().toISOString();
    const fields = (
      previous: readonly Version[],
      kept?: NoteValue,
      newScope?: string,
    ): NoteValue => {
      const scope =
        input.scope === undefined
          ? kept === undefined
            ? newScope
            : kept.scope
          : (input.scope ?? undefined);
      const tags = input.tags ?? kept?.tags ?? [];
      const changed =
        !kept ||
        input.text !== kept.text ||
        scope !== kept.scope ||
        canonical(tags) !== canonical(kept.tags);
      return {
        text: input.text,
        createdAt: kept?.createdAt ?? at,
        ...(kept?.createdAtApprox ? { createdAtApprox: true as const } : {}),
        changedAt: changed ? at : (kept?.changedAt ?? kept?.createdAt ?? at),
        textAt: at,
        ...(scope === undefined ? {} : { scope }),
        tags,
        links: qualifiedLinks(input.links ?? kept?.links ?? []),
        previous,
        ...(kept?.approval === undefined ? {} : { approval: kept.approval }),
        ...(kept?.from === undefined ? {} : { from: kept.from }),
        ...(kept?.proposedForget === true
          ? { proposedForget: true as const }
          : {}),
      };
    };
    const editing = input.id === undefined ? undefined : qualified(input.id);
    if (editing !== undefined) {
      // The id says where the note lives; another project's notes are never changed from here.
      const found = await sourceFor(services, editing);
      if (unreached(found))
        return { status: "not_found" as const, id: editing };
      const { source, number } = found;
      if (source.readOnly) return { status: "read_only" as const, id: editing };
      const key = noteKey(number);
      const existing = source.state.get(key);
      const old = existing && (existing.value as NoteValue);
      if (!existing || !old || old.deleted === true)
        return { status: "not_found" as const, id: editing };
      const removed =
        input.tags === undefined
          ? undefined
          : ownerTag(
              old.tags.filter((tag) => !input.tags!.includes(tag)),
              config,
            );
      const approval =
        removed === undefined
          ? old.approval
          : approved(input.approval, "memory.add", removed);
      const stamps = shown(source.state, existing, old);
      const value = fields(
        versionsOf(existing, old)
          .map((version, i) => ({
            ...version,
            text: old.previous[i]?.text ?? old.text,
            at: stamps[i]!.at,
          }))
          .slice(-MAX_VERSIONS),
        {
          ...old,
          ...dates(source.state, existing, old),
          changedAt: contentTime(source.state, existing, old),
        },
      );
      if (approval !== undefined) Object.assign(value, { approval });
      if (removed !== undefined)
        Object.assign(value, { versionApproval: approval });
      // Moves keep text version numbers while the destination store starts at revision one.
      if ((old.textRevision ?? 0) > existing.revision)
        Object.assign(value, { textRevision: old.textRevision! + 1 });
      const expected = canonical(value);
      const record = source.state.put(key, value, {
        expectRevision: input.expectRevision ?? existing.revision,
      });
      const read = source.state.get(key);
      if (
        canonical(read) !== canonical(record) ||
        canonical(read?.value) !== expected
      )
        fail(
          "INTERNAL",
          "memory.add write did not match its readback; reconcile with memory.show before retrying",
        );
      return {
        status: "updated" as const,
        id: editing,
        note: present(
          source,
          editing,
          record,
          record.value as NoteValue,
          input.text,
        ),
      };
    }
    const target = await writeTarget(
      services,
      chooseLevel(input.level, config, services),
    );
    // The number and the note it numbers commit together.
    return committed(() => {
      const counter = readCounter(target.state, NOTE_COUNTER);
      const number = counter.last + 1;
      const value = fields(
        [],
        undefined,
        target.level === "device" && input.scope === undefined
          ? resolvedScope(config, services)
          : undefined,
      );
      const expected = canonical(value);
      const [, record] = target.state.putMany([
        {
          key: NOTE_COUNTER,
          value: { last: number },
          expectRevision: counter.revision,
        },
        {
          key: noteKey(number),
          value,
          expectRevision: 0,
        },
      ]);
      const read = target.state.get(noteKey(number));
      if (
        !record ||
        canonical(read) !== canonical(record) ||
        canonical(read?.value) !== expected
      )
        fail(
          "INTERNAL",
          "memory.add write did not match its readback; reconcile with memory.show before retrying",
        );
      const id = idIn(target, number);
      return {
        status: "added" as const,
        id,
        note: present(
          target,
          id,
          record,
          record.value as NoteValue,
          input.text,
        ),
      };
    });
  },

  "memory.search": async ({
    input,
    services,
  }: {
    input: {
      query: string;
      level?: Level;
      projects?: readonly string[];
      scope?: string;
      tag?: string;
      limit?: number;
      cursor?: string;
    };
    services: Services;
  }) => {
    // Inside a project a search covers that project and the device. Another project is searched
    // only when the caller names it, and its notes come back read-only.
    const sources: Source[] = [];
    const unreachable: Unreached[] = [];
    if (input.level !== "project") sources.push(deviceSource(services.state));
    if (input.level !== "device" && services.levels.inProject) {
      const own = await ownProject(services);
      if (own) sources.push(own);
    }
    for (const ref of input.projects ?? []) {
      const other = await pulled(services, ref);
      if (!isSource(other)) unreachable.push(other);
      else if (!sources.some((source) => source.prefix === other.prefix))
        sources.push(other);
    }
    const wanted = [...new Set(terms(input.query).map(stem))];
    // Each source keeps its own bound: a page looks at the newest notes of each source below its
    // bound, and the sources share one window of SEARCH_WINDOW records. The cursor continues inside
    // the window (skip) and then on to each source's next older window, so every note can be
    // reached; a source with nothing older is marked x.
    const [boundText = "", skipText = "0"] = (input.cursor ?? "").split(":");
    const bounds =
      input.cursor === undefined
        ? sources.map(() => 0)
        : boundText
            .split(".")
            .map((bound) => (bound === "x" ? -1 : Number(bound)));
    if (bounds.length !== sources.length)
      fail(
        "INPUT_INVALID",
        "This cursor belongs to a search over other levels or projects; repeat that search's level and projects",
      );
    const skip = Number(skipText);
    const window = Math.max(
      1,
      Math.floor(SEARCH_WINDOW / Math.max(1, sources.length)),
    );
    const pages = sources.map((source, index) => {
      const bound = bounds[index]!;
      const records =
        bound === -1
          ? []
          : notePage(source, {
              ...(bound === 0 ? {} : { before: bound }),
              limit: window,
              descending: true,
            });
      return {
        source,
        index,
        bound,
        records,
        older: records.length === window,
      };
    });
    const documents = pages.flatMap((page) =>
      page.records
        .filter(
          (note) =>
            note.value.deleted !== true &&
            (input.scope === undefined || note.value.scope === input.scope) &&
            (input.tag === undefined || note.value.tags.includes(input.tag)),
        )
        .map((note) => {
          const counts = new Map<string, number>();
          let length = 0;
          for (const term of terms(
            `${note.value.text} ${note.value.tags.join(" ")}`,
          )) {
            const key = stem(term);
            counts.set(key, (counts.get(key) ?? 0) + 1);
            length += 1;
          }
          return {
            note,
            source: page.source,
            order: page.index,
            counts,
            length,
          };
        }),
    );
    const total = documents.length;
    // Corpus-wide facts are worked out once per query word, not once per note.
    const holders = new Map<string, number>();
    for (const term of wanted) {
      let count = 0;
      for (const document of documents)
        if (document.counts.has(term)) count += 1;
      holders.set(term, count);
    }
    const average =
      documents.reduce((sum, document) => sum + document.length, 0) /
      Math.max(1, total);
    // Any query term may match (an agent's natural-language prompt never has every word in one
    // note); notes that match more, rarer terms rank first, newest first on a tie.
    const scored = documents
      .map((document) => {
        let score = 0;
        for (const term of wanted) {
          const frequency = document.counts.get(term);
          if (frequency === undefined) continue;
          const held = holders.get(term) ?? 0;
          const rarity = Math.log(1 + (total - held + 0.5) / (held + 0.5));
          const norm =
            1.2 * (0.25 + (0.75 * document.length) / Math.max(1, average));
          score += (rarity * frequency * 2.2) / (frequency + norm);
        }
        return { document, score };
      })
      .filter((entry) => entry.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.document.note.number - a.document.note.number ||
          a.document.order - b.document.order,
      );
    const limit = input.limit ?? DEFAULT_LIMIT;
    // The walk is pinned to where it began: the first page's cursor carries, per source, a bound
    // just above its newest note then, so notes written during the walk are never in a later page
    // and ranks below the bound cannot shift under it.
    const pinned = pages.map((page) => {
      if (page.bound !== 0) return page.bound;
      const first = page.records[0];
      return first ? first.number + 1 : -1;
    });
    const encode = (values: readonly number[], at: number) =>
      `${values.map((value) => (value === -1 ? "x" : String(value))).join(".")}:${at}`;
    const olderBounds = pages.map((page) => {
      const oldest = page.records[page.records.length - 1];
      return page.older && oldest ? oldest.number : -1;
    });
    const next =
      skip + limit < scored.length
        ? encode(pinned, skip + limit)
        : olderBounds.some((bound) => bound !== -1)
          ? encode(olderBounds, 0)
          : undefined;
    return {
      hits: scored.slice(skip, skip + limit).map(({ document, score }) => {
        const { note, source } = document;
        return {
          id: note.id,
          ...label(source),
          score: Math.round(score * 1000) / 1000,
          revision: note.record.revision,
          ...(note.value.scope === undefined
            ? {}
            : { scope: note.value.scope }),
          tags: [...note.value.tags],
          ...(note.value.proposedForget === true
            ? { proposedForget: true as const }
            : {}),
          snippet: fence(
            snippet(note.value.text, wanted),
            `memory:${note.id}`,
            note.record.updatedAt,
          ),
          updatedAt: note.record.updatedAt,
          ...dates(source.state, note.record, note.value),
        };
      }),
      matched: scored.length,
      scanned: documents.length,
      ...(unreachable.length === 0 ? {} : { unreachable }),
      truncated: next !== undefined,
      ...(next === undefined ? {} : { next }),
    };
  },

  "memory.show": async ({
    input,
    services,
  }: {
    input: { id: string; revision?: number };
    services: Services;
  }) => {
    const found = await sourceFor(services, qualified(input.id));
    if (unreached(found)) {
      if (found.status === "not_found") return { status: "not_found" as const };
      return { status: "unavailable" as const, project: found.ref };
    }
    const { source, number } = found;
    const record = source.state.get(noteKey(number));
    if (!record) return { status: "not_found" as const };
    const value = record.value as NoteValue;
    if (value.deleted === true)
      return value.movedTo === undefined
        ? {
            status: "forgotten" as const,
            ...audit(value.approval, `memory:${qualified(input.id)}`),
          }
        : { status: "moved" as const, to: value.movedTo };
    if (
      input.revision === undefined ||
      (input.revision === record.revision &&
        !value.previous.some((entry) => entry.revision === input.revision)) ||
      input.revision === value.textRevision
    )
      return {
        status: "found" as const,
        note: present(
          source,
          qualified(input.id),
          record,
          value,
          value.text,
          shown(source.state, record, value),
        ),
      };
    const older = value.previous.find(
      (entry) => entry.revision === input.revision,
    );
    if (!older) return { status: "version_unavailable" as const };
    return {
      status: "found" as const,
      note: present(
        source,
        qualified(input.id),
        record,
        value,
        older.text,
        shown(source.state, record, value),
      ),
    };
  },

  "memory.propose-forget": async ({
    input,
    services,
  }: {
    input: { id: string; expectRevision?: number; withdraw?: boolean };
    services: Services;
  }) => {
    const id = qualified(input.id);
    const found = await sourceFor(services, id);
    if (unreached(found)) return { status: "not_found" as const, id };
    const { source, number } = found;
    if (source.readOnly) return { status: "read_only" as const, id };
    const key = noteKey(number);
    const existing = source.state.get(key);
    if (!existing) return { status: "not_found" as const, id };
    const old = existing.value as NoteValue;
    if (old.deleted === true)
      return { status: "already_forgotten" as const, id };
    const withdraw = input.withdraw === true;
    if ((old.proposedForget === true) !== withdraw)
      return {
        status: withdraw
          ? ("not_proposed" as const)
          : ("already_proposed" as const),
        id,
        note: present(source, id, existing, old, old.text),
      };
    const { proposedForget: _proposal, ...kept } = old;
    const value: NoteValue = {
      ...kept,
      textRevision: old.textRevision ?? existing.revision,
      ...(withdraw ? {} : { proposedForget: true as const }),
    };
    const record = source.state.put(key, value, {
      expectRevision: input.expectRevision ?? existing.revision,
    });
    return {
      status: withdraw ? ("withdrawn" as const) : ("proposed" as const),
      id,
      note: present(source, id, record, value, value.text),
    };
  },

  "memory.forget": async ({
    input,
    config = {},
    services,
  }: {
    input: {
      id: string;
      expectRevision?: number;
      undo?: boolean;
      approval?: Approval;
    };
    config?: MemoryConfig;
    services: Services;
  }) => {
    const found = await sourceFor(services, qualified(input.id));
    if (unreached(found)) {
      approved(input.approval, "memory.forget");
      return { status: "not_found" as const, id: qualified(input.id) };
    }
    const { source, number } = found;
    if (source.readOnly) {
      approved(input.approval, "memory.forget");
      return { status: "read_only" as const, id: qualified(input.id) };
    }
    const key = noteKey(number);
    const existing = source.state.get(key);
    if (!existing) {
      approved(input.approval, "memory.forget");
      return { status: "not_found" as const, id: qualified(input.id) };
    }
    const old = existing.value as NoteValue;
    const approval = approved(
      input.approval,
      "memory.forget",
      ownerTag(
        old.deleted === true ? (old.forgotten?.tags ?? []) : old.tags,
        config,
      ),
    );
    if (input.undo === true) {
      if (old.deleted !== true)
        return { status: "not_forgotten" as const, id: qualified(input.id) };
      if (old.movedTo !== undefined || old.forgotten === undefined)
        return { status: "undo_unavailable" as const, id: qualified(input.id) };
      const value = { ...old.forgotten, approval };
      const record = source.state.put(key, value, {
        expectRevision: input.expectRevision ?? existing.revision,
      });
      return {
        status: "restored" as const,
        id: qualified(input.id),
        note: present(source, qualified(input.id), record, value, value.text),
      };
    }
    if (old.deleted === true)
      return { status: "already_forgotten" as const, id: qualified(input.id) };
    source.state.put(
      key,
      {
        ...TOMBSTONE,
        forgotten: {
          ...old,
          textRevision: old.textRevision ?? existing.revision,
        },
        approval,
      },
      {
        expectRevision: input.expectRevision ?? existing.revision,
      },
    );
    return { status: "forgotten" as const, id: qualified(input.id) };
  },

  "memory.move": async ({
    input,
    services,
  }: {
    input: { id: string; to: Level; expectRevision: number; keep?: boolean };
    services: Services;
  }) => {
    const found = await sourceFor(services, qualified(input.id));
    if (unreached(found))
      return { status: "not_found" as const, id: qualified(input.id) };
    const { source, number } = found;
    if (source.readOnly)
      return { status: "read_only" as const, id: qualified(input.id) };
    if (source.level === input.to)
      return { status: "same_level" as const, id: qualified(input.id) };
    const key = noteKey(number);
    const existing = source.state.get(key);
    if (!existing)
      return { status: "not_found" as const, id: qualified(input.id) };
    const value = existing.value as NoteValue;
    // A finished move answers the same way every time it is repeated.
    if (value.deleted === true)
      return value.movedTo === undefined
        ? { status: "forgotten" as const, id: qualified(input.id) }
        : {
            status: "moved" as const,
            id: qualified(input.id),
            to: value.movedTo,
            transfer: qualified(input.id),
          };
    if (existing.revision !== input.expectRevision)
      fail(
        "REVISION_CONFLICT",
        `${qualified(input.id)} is at revision ${existing.revision}; read it again and move that revision`,
      );
    const target = await writeTarget(services, input.to);
    // The source's id is the transfer's identity. The destination records it beside the copy in
    // the same transaction, so a retry after a failure between the two stores finds the copy it
    // already made instead of making another.
    const marker = `${TRANSFER_PREFIX}${qualified(input.id)}`;
    const stamps = shown(source.state, existing, value);
    const copy: NoteValue = {
      text: value.text,
      ...dates(source.state, existing, value),
      changedAt: contentTime(source.state, existing, value),
      textAt: stamps.at(-1)!.at,
      textRevision: value.textRevision ?? existing.revision,
      ...(value.approval ? { approval: value.approval } : {}),
      ...(value.versionApproval
        ? { versionApproval: value.versionApproval }
        : {}),
      ...(value.scope === undefined ? {} : { scope: value.scope }),
      tags: value.tags,
      links: qualifiedLinks(value.links),
      previous: value.previous.map((version, i) => ({
        ...version,
        at: stamps[i]!.at,
      })),
      from: qualified(input.id),
      ...(value.proposedForget === true
        ? { proposedForget: true as const }
        : {}),
    };
    // The transfer record names the copy and the revisions it was made at: the copy's own revision
    // and the source revision it was taken from. The copy and its record commit together, so a
    // destination at another revision was changed after the transfer, never left half-made.
    const placed = committed(
      ():
        | { readonly at: number; readonly settled: boolean }
        | { readonly conflict: string } => {
        const made = target.state.get(marker);
        const recorded = made?.value as Transfer | undefined;
        const counter = readCounter(target.state, NOTE_COUNTER);
        const at = recorded?.number ?? counter.last + 1;
        const current = target.state.get(noteKey(at));
        if (made && recorded) {
          // A transfer of another source revision is a different transfer, never a retry.
          if (recorded.sourceRevision !== existing.revision)
            return {
              conflict: `${qualified(input.id)} was copied to ${idIn(target, at)} from revision ${recorded.sourceRevision}, not ${existing.revision}; nothing was written`,
            };
          // The same transfer again. Someone edited or forgot the copy since: it is never redone,
          // and a move retires its source only while the copy still holds the note.
          if (current && current.revision !== recorded.revision) {
            const live = (current.value as NoteValue).deleted !== true;
            return input.keep === true || live
              ? { at, settled: true }
              : {
                  conflict: `${idIn(target, at)} was forgotten after ${qualified(input.id)} was copied there; nothing was written`,
                };
          }
          if (current) return { at, settled: true };
        }
        // The first copy, or a transfer record whose copy never landed.
        const written = (current?.revision ?? 0) + 1;
        target.state.putMany([
          ...(recorded
            ? []
            : [
                {
                  key: NOTE_COUNTER,
                  value: { last: at },
                  expectRevision: counter.revision,
                },
              ]),
          {
            key: noteKey(at),
            value: copy,
            expectRevision: current?.revision ?? 0,
          },
          {
            key: marker,
            value: {
              number: at,
              revision: written,
              sourceRevision: existing.revision,
            } satisfies Transfer,
            expectRevision: made?.revision ?? 0,
          },
        ]);
        return { at, settled: false };
      },
    );
    if ("conflict" in placed) return fail("TRANSFER_CONFLICT", placed.conflict);
    const to = idIn(target, placed.at);
    if (input.keep === true)
      return {
        status: "copied" as const,
        id: qualified(input.id),
        to,
        transfer: qualified(input.id),
      };
    // Retiring the source comes last: until it commits, the source still holds the note.
    source.state.put(
      key,
      { ...TOMBSTONE, movedTo: to },
      { expectRevision: existing.revision },
    );
    return {
      status: "moved" as const,
      id: qualified(input.id),
      to,
      transfer: qualified(input.id),
    };
  },

  "memory.export": async ({
    input,
    services,
  }: {
    input: { level: Level; scope?: string; after?: number };
    services: Services;
  }) => {
    const source =
      input.level === "device"
        ? deviceSource(services.state)
        : services.levels.inProject
          ? await ownProject(services)
          : fail(
              "LEVEL_UNAVAILABLE",
              'This host serves no project, so it cannot export level "project".',
            );
    const origin =
      source?.origin.level === "project"
        ? { project: source.origin.project }
        : {};
    // A project with no identity yet has no notes.
    if (!source)
      return {
        format: "forge.memory.export/2" as const,
        level: input.level,
        count: 0,
        truncated: false,
        notes: [],
      };
    // Read one page of records after the cursor; forgotten and out-of-scope ones are passed over
    // but still move the cursor, so a long run of them never stalls a walk.
    const records = notePage(source, {
      after: input.after ?? 0,
      limit: EXPORT_READ,
      descending: false,
    });
    // One chunk is what a single restore accepts and what the runtime lets one call return.
    const chosen: typeof records = [];
    let chars = 0;
    let examined: number | undefined;
    let stopped = false;
    for (const note of records) {
      const live =
        note.value.deleted !== true &&
        (input.scope === undefined || note.value.scope === input.scope);
      if (live) {
        if (
          chosen.length >= CHUNK_NOTES ||
          (chosen.length > 0 && chars + note.value.text.length > CHUNK_CHARS)
        ) {
          stopped = true;
          break;
        }
        chosen.push(note);
        chars += note.value.text.length;
      }
      examined = note.number;
    }
    const more = stopped || records.length === EXPORT_READ;
    return {
      format: "forge.memory.export/2" as const,
      level: input.level,
      ...origin,
      count: chosen.length,
      truncated: more,
      ...(more && examined !== undefined ? { next: examined } : {}),
      notes: chosen.map((note) => ({
        id: note.id,
        revision: note.record.revision,
        ...(note.value.scope === undefined ? {} : { scope: note.value.scope }),
        tags: [...note.value.tags],
        links: qualifiedLinks(note.value.links),
        text: {
          kind: "untrusted" as const,
          source: `memory:${note.id}`,
          text: note.value.text,
        },
      })),
    };
  },

  "memory.restore": async ({
    input,
    config = {},
    services,
  }: {
    input: {
      format: "forge.memory.export/1" | "forge.memory.export/2";
      level?: Level;
      project?: ProjectIdentity;
      approval?: Approval;
      notes: readonly {
        id: string;
        scope?: string;
        tags: readonly string[];
        links: readonly string[];
        text: { text: string };
      }[];
    };
    config?: MemoryConfig;
    services: Services;
  }) => {
    // Notes go back to the level they were exported from, in the store this call reaches: the
    // device, or the caller's own project. An export from before levels holds device notes.
    const level: Level =
      input.format === "forge.memory.export/1"
        ? "device"
        : (input.level ?? "device");
    const target = await writeTarget(services, level);
    const { state } = target;
    // A link to a note of the exported project moves to the restoring project only when that note
    // is restored by this call, so the link and its note arrive together. Every other link, to a
    // note left out of the export, the device or another project, stays exactly as it was.
    const exported =
      level === "project" && input.project !== undefined
        ? `project/${input.project.id}/`
        : undefined;
    const relinked = (
      links: readonly string[],
      restored: ReadonlySet<string>,
    ) =>
      qualifiedLinks(links).map((link) =>
        exported !== undefined &&
        link.startsWith(exported) &&
        restored.has(link)
          ? `${target.prefix}/${link.slice(exported.length)}`
          : link,
      );
    // One transaction for the whole page and the counter that must stay ahead of it.
    return committed(() => {
      let skipped = 0;
      const conflicts: string[] = [];
      const entries: BatchEntry[] = [];
      const queued = new Set<string>();
      // The exported ids of the notes this call restores: added, or already here unchanged.
      const restored = new Set<string>();
      const adding: { key: string; note: (typeof input.notes)[number] }[] = [];
      let highest = 0;
      for (const note of input.notes) {
        const ref = parseRef(note.id);
        if (!ref || ref.level !== level) {
          conflicts.push(qualified(note.id));
          continue;
        }
        const key = noteKey(ref.number);
        const id = idIn(target, ref.number);
        highest = Math.max(highest, ref.number);
        const existing = state.get(key);
        if (existing) {
          const old = existing.value as NoteValue;
          if (old.deleted !== true && old.text === note.text.text) {
            skipped += 1;
            restored.add(qualified(note.id));
          } else conflicts.push(id);
          continue;
        }
        if (queued.has(key)) {
          conflicts.push(id);
          continue;
        }
        queued.add(key);
        restored.add(qualified(note.id));
        adding.push({ key, note });
      }
      const approval = approved(
        input.approval,
        "memory.restore",
        ownerTag(
          adding.flatMap(({ note }) => note.tags),
          config,
        ),
      );
      for (const { key, note } of adding)
        entries.push({
          key,
          value: {
            text: note.text.text,
            createdAt: approval.at,
            changedAt: approval.at,
            textAt: approval.at,
            versionApproval: approval,
            ...(note.scope === undefined ? {} : { scope: note.scope }),
            tags: note.tags,
            links: relinked(note.links, restored),
            previous: [],
            approval,
          },
          expectRevision: 0,
        });
      const added = entries.length;
      const counter = readCounter(state, NOTE_COUNTER);
      if (counter.last < highest)
        entries.push({
          key: NOTE_COUNTER,
          value: { last: highest },
          expectRevision: counter.revision,
        });
      if (entries.length > 0) state.putMany(entries);
      return { added, skipped, conflicts };
    });
  },

  "decision.propose": ({
    input,
    config,
    services,
  }: {
    input: { title: string; text: string; consequences?: string };
    config: MemoryConfig;
    services: Services;
  }) => {
    const format = config.decisions;
    if (format?.idPattern === undefined)
      return {
        status: "format_missing" as const,
        repair:
          "Set /blocks/memory/config/decisions/idPattern to the project's record id shape (for example D-NNN). Run `forge project detect` to see the detected value under /blocks/project/detected/decisions/records.",
      };
    const { state } = services;
    // The number, the record and the lookup by project id commit together.
    const { id, value, record } = committed(() => {
      const counter = readCounter(state, DECISION_COUNTER);
      const number = Math.max(counter.last, format.highest ?? 0) + 1;
      const id = formatId(format.idPattern as string, number);
      const value: DecisionValue = {
        id,
        number,
        title: input.title,
        text: input.text,
        ...(input.consequences === undefined
          ? {}
          : { consequences: input.consequences }),
        status: "proposed",
        proposedAt: new Date().toISOString(),
      };
      const [, record] = state.putMany([
        {
          key: DECISION_COUNTER,
          value: { last: number },
          expectRevision: counter.revision,
        },
        { key: numberKey(DECISION_PREFIX, number), value, expectRevision: 0 },
        {
          key: `${DECISION_ID_PREFIX}${id}`,
          value: { number },
          expectRevision: 0,
        },
      ]);
      if (!record) throw new Error("decision was not written");
      return { id, value, record };
    });
    const rendered =
      format.path === undefined || format.layout === undefined
        ? undefined
        : format.layout === "single-file"
          ? {
              path: format.path,
              mode: "append" as const,
              content: `\n## ${decisionText(value, "proposed")}`,
            }
          : {
              path: `${format.path}/${id}-${slug(input.title)}.md`,
              mode: "create" as const,
              content: `# ${decisionText(value, "proposed")}`,
            };
    return {
      status: "proposed" as const,
      id,
      revision: record.revision,
      ...(rendered === undefined ? {} : { file: rendered }),
    };
  },

  "decision.adopt": ({
    input,
    config = {},
    services,
  }: {
    input: { id: string; expectRevision?: number; approval?: Approval };
    config?: MemoryConfig;
    services: Services;
  }) => {
    const approval = approved(
      input.approval,
      "decision.adopt",
      config.approval?.adopt === "agent" ? undefined : "adopt",
    );
    const { state } = services;
    const index = state.get(`${DECISION_ID_PREFIX}${input.id}`);
    const match = index
      ? state.get(
          numberKey(
            DECISION_PREFIX,
            (index.value as { number: number }).number,
          ),
        )
      : undefined;
    if (!match) return { status: "not_found" as const, id: input.id };
    const value = decisionOf(match);
    if (value.status === "adopted")
      return { status: "already_adopted" as const, id: input.id };
    const record = state.put(
      match.key,
      { ...value, status: "adopted", approval },
      { expectRevision: input.expectRevision ?? match.revision },
    );
    return {
      status: "adopted" as const,
      id: input.id,
      revision: record.revision,
    };
  },

  "decision.list": ({
    input,
    services,
  }: {
    input: { status?: "proposed" | "adopted"; after?: number };
    services: Services;
  }) => {
    // Read one page after the cursor; the status filter runs on what was read.
    const records = services.state.listRange({
      from: numberKey(DECISION_PREFIX, (input.after ?? 0) + 1),
      to: DECISION_END,
      limit: LIST_LIMIT + 1,
    });
    const page = records.slice(0, LIST_LIMIT);
    const last = page[page.length - 1];
    const more = records.length > LIST_LIMIT;
    return {
      truncated: more,
      ...(more && last ? { next: decisionOf(last).number } : {}),
      decisions: page
        .filter(
          (record) =>
            input.status === undefined ||
            decisionOf(record).status === input.status,
        )
        .map((record) => {
          const value = decisionOf(record);
          return {
            id: value.id,
            number: value.number,
            status: value.status,
            revision: record.revision,
            title: fence(value.title, `decision:${value.id}`, record.updatedAt),
            updatedAt: record.updatedAt,
            proposedAt:
              value.proposedAt ??
              services.state.history({
                key: record.key,
                before: 2,
                limit: 1,
              })[0]?.at ??
              record.updatedAt,
            ...(value.status === "adopted"
              ? { adoptedAt: value.approval?.at ?? record.updatedAt }
              : {}),
            ...audit(value.approval, `decision:${value.id}`),
          };
        }),
    };
  },
};
