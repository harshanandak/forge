// forge/memory: project and device knowledge. One self-contained file: no imports at run time, no
// clock, no files, only the bound `state` client.
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
}
interface NoteValue {
  readonly text: string;
  readonly scope?: string;
  readonly tags: readonly string[];
  readonly links: readonly string[];
  readonly previous: readonly Version[];
  /** The note this one was moved or copied from: the transfer's identity. */
  readonly from?: string;
  readonly deleted?: true;
  /** On a moved note's tombstone: where it went. */
  readonly movedTo?: string;
}
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
): { revision: number; at?: string }[] {
  return [
    ...value.previous.map((entry) => ({ revision: entry.revision })),
    { revision: record.revision, at: record.updatedAt },
  ];
}
function present(
  source: Source,
  id: string,
  record: StateRecord,
  value: NoteValue,
  text: string,
  versions: { revision: number; at?: string }[] = versionsOf(record, value),
) {
  return {
    id,
    ...label(source),
    revision: record.revision,
    ...(value.scope === undefined ? {} : { scope: value.scope }),
    tags: [...value.tags],
    links: qualifiedLinks(value.links),
    ...(value.from === undefined ? {} : { from: value.from }),
    text: fence(text, `memory:${id}`, record.updatedAt),
    updatedAt: record.updatedAt,
    versions,
  };
}

/** Show adds timestamps from one bounded, indexed page of the note's own history. */
function shown(
  state: ExtendedStateClient,
  record: StateRecord,
  value: NoteValue,
): { revision: number; at?: string }[] {
  const at = new Map(
    state
      .history({ key: record.key, limit: MAX_VERSIONS + 1 })
      .map((event) => [event.revision, event.at] as const),
  );
  return versionsOf(record, value).map((version) => {
    const when = at.get(version.revision);
    return when === undefined ? version : { ...version, at: when };
  });
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

function resolvedScope(
  config: MemoryConfig,
  services: Services,
): string | undefined {
  return services.levels.inProject
    ? (config.scope ?? services.levels.defaultScope)
    : undefined;
}

module.exports = {
  "memory.scope": ({
    config = {},
    services,
  }: {
    config?: MemoryConfig;
    services: Services;
  }) => ({
    scope: resolvedScope(config, services) ?? "general",
  }),
  "memory.rules": async ({
    config = {},
    services,
  }: {
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
    if (scope !== undefined) counts.set(scope, 0);
    for (const source of sources) {
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
        (scope === undefined || scope === "general"
          ? "general"
          : scope + " or general") +
        ".",
      'forge memory search "<topic>"',
      "forge memory show <id>",
    ].join("\n");
    return { text: fence(text, "memory:rules") };
  },

  "memory.add": async ({
    input,
    config = {},
    services,
  }: {
    input: NoteFields & { id?: string; level?: Level; expectRevision?: number };
    config?: MemoryConfig;
    services: Services;
  }) => {
    // An edit is a partial update: a field left out keeps its stored value, and clearing is said
    // outright (null for the scope, an empty list for tags or links). A new note has nothing to keep.
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
      return {
        text: input.text,
        ...(scope === undefined ? {} : { scope }),
        tags: input.tags ?? kept?.tags ?? [],
        links: qualifiedLinks(input.links ?? kept?.links ?? []),
        previous,
        ...(kept?.from === undefined ? {} : { from: kept.from }),
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
      const record = source.state.put(
        key,
        fields(
          [
            ...old.previous,
            { revision: existing.revision, text: old.text },
          ].slice(-MAX_VERSIONS),
          old,
        ),
        { expectRevision: input.expectRevision ?? existing.revision },
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
      const [, record] = target.state.putMany([
        {
          key: NOTE_COUNTER,
          value: { last: number },
          expectRevision: counter.revision,
        },
        {
          key: noteKey(number),
          value: fields(
            [],
            undefined,
            target.level === "device" && input.scope === undefined
              ? resolvedScope(config, services)
              : undefined,
          ),
          expectRevision: 0,
        },
      ]);
      if (!record) throw new Error("note was not written");
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
    config = {},
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
    config?: MemoryConfig;
    services: Services;
  }) => {
    const scope =
      input.scope === undefined
        ? (resolvedScope(config, services) ?? "general")
        : undefined;
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
    // Scope preference changes order, never visibility. Within each group, any query term may
    // match; more, rarer terms rank first, newest first on a tie.
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
        return {
          document,
          score,
          preferred: Number(
            input.scope === undefined &&
              (document.note.value.scope === scope ||
                document.note.value.scope === "general"),
          ),
        };
      })
      .filter((entry) => entry.score > 0)
      .sort(
        (a, b) =>
          b.preferred - a.preferred ||
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
          snippet: fence(
            snippet(note.value.text, wanted),
            `memory:${note.id}`,
            note.record.updatedAt,
          ),
          updatedAt: note.record.updatedAt,
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
        ? { status: "forgotten" as const }
        : { status: "moved" as const, to: value.movedTo };
    if (input.revision === undefined || input.revision === record.revision)
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

  "memory.forget": async ({
    input,
    services,
  }: {
    input: { id: string; expectRevision?: number };
    services: Services;
  }) => {
    const found = await sourceFor(services, qualified(input.id));
    if (unreached(found))
      return { status: "not_found" as const, id: qualified(input.id) };
    const { source, number } = found;
    if (source.readOnly)
      return { status: "read_only" as const, id: qualified(input.id) };
    const key = noteKey(number);
    const existing = source.state.get(key);
    if (!existing)
      return { status: "not_found" as const, id: qualified(input.id) };
    if ((existing.value as NoteValue).deleted === true)
      return { status: "already_forgotten" as const, id: qualified(input.id) };
    source.state.put(key, TOMBSTONE, {
      expectRevision: input.expectRevision ?? existing.revision,
    });
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
    const copy: NoteValue = {
      text: value.text,
      ...(value.scope === undefined ? {} : { scope: value.scope }),
      tags: value.tags,
      links: qualifiedLinks(value.links),
      previous: [],
      from: qualified(input.id),
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
    services,
  }: {
    input: {
      format: "forge.memory.export/1" | "forge.memory.export/2";
      level?: Level;
      project?: ProjectIdentity;
      notes: readonly {
        id: string;
        scope?: string;
        tags: readonly string[];
        links: readonly string[];
        text: { text: string };
      }[];
    };
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
      for (const { key, note } of adding)
        entries.push({
          key,
          value: {
            text: note.text.text,
            ...(note.scope === undefined ? {} : { scope: note.scope }),
            tags: note.tags,
            links: relinked(note.links, restored),
            previous: [],
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
    services,
  }: {
    input: { id: string; expectRevision?: number };
    services: Services;
  }) => {
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
      { ...value, status: "adopted" },
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
          };
        }),
    };
  },
};
