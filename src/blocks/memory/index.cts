// forge/memory: project and device knowledge. One self-contained file, because the sync profile runs
// a block's entry alone: no imports at run time, no clock, no files, only the bound `state` client.
// Notes live in the device store (`device` context); decisions live in the project store.
import type {
  BatchEntry,
  ExtendedStateClient,
  StateClient,
  StateRecord,
} from "../../contract/author.ts";

interface Services {
  readonly state: ExtendedStateClient;
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
  readonly deleted?: true;
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
interface MemoryConfig {
  readonly decisions?: DecisionFormat;
}

// Keys carry zero-padded numbers, so key order is number order and a range of keys is a range of
// numbers. Every call reads one page of that range, never the whole store.
const NOTE_PREFIX = "note/";
const NOTE_END = "note/\u{10FFFF}";
const NOTE_COUNTER = "meta/note-counter";
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
 * start again from fresh reads. Every write the block makes is one such transaction, so one
 * operation costs one durable commit however many records it touches.
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

function noteId(number: number): string {
  return `note-${number}`;
}
function noteNumber(id: string): number {
  return Number(id.slice("note-".length));
}
function numberKey(prefix: string, number: number): string {
  return `${prefix}${String(number).padStart(9, "0")}`;
}
function noteKey(id: string): string {
  return numberKey(NOTE_PREFIX, noteNumber(id));
}
function noteOf(record: StateRecord): { id: string; value: NoteValue } {
  return {
    id: noteId(Number(record.key.slice(NOTE_PREFIX.length))),
    value: record.value as NoteValue,
  };
}
/**
 * One page of note records (tombstones included) from a range of note numbers. At most `limit`
 * records are read from the store, whatever the store holds.
 */
function notePage(
  state: ExtendedStateClient,
  options: {
    readonly after?: number;
    readonly before?: number;
    readonly limit: number;
    readonly descending: boolean;
  },
): { id: string; value: NoteValue; record: StateRecord }[] {
  return state
    .listRange({
      from: numberKey(NOTE_PREFIX, (options.after ?? 0) + 1),
      to:
        options.before === undefined
          ? NOTE_END
          : numberKey(NOTE_PREFIX, options.before),
      limit: options.limit,
      descending: options.descending,
    })
    .map((record) => ({ ...noteOf(record), record }));
}
function versionsOf(
  state: StateClient,
  key: string,
): { revision: number; at: string }[] {
  return state.events(key).map((event) => ({
    revision: event.revision,
    at: event.at,
  }));
}
function present(
  state: StateClient,
  id: string,
  record: StateRecord,
  value: NoteValue,
  text: string,
) {
  return {
    id,
    revision: record.revision,
    ...(value.scope === undefined ? {} : { scope: value.scope }),
    tags: [...value.tags],
    links: [...value.links],
    text: fence(text, `memory:${id}`, record.updatedAt),
    updatedAt: record.updatedAt,
    versions: versionsOf(state, record.key),
  };
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

module.exports = {
  "memory.add": ({
    input,
    services,
  }: {
    input: NoteFields & { id?: string; expectRevision?: number };
    services: Services;
  }) => {
    const { state } = services;
    // An edit is a partial update: a field left out keeps its stored value, and clearing is said
    // outright (null for the scope, an empty list for tags or links). A new note has nothing to keep.
    const fields = (
      previous: readonly Version[],
      kept?: NoteValue,
    ): NoteValue => {
      const scope =
        input.scope === undefined ? kept?.scope : (input.scope ?? undefined);
      return {
        text: input.text,
        ...(scope === undefined ? {} : { scope }),
        tags: input.tags ?? kept?.tags ?? [],
        links: input.links ?? kept?.links ?? [],
        previous,
      };
    };
    if (input.id !== undefined) {
      const key = noteKey(input.id);
      const existing = state.get(key);
      const old = existing && (existing.value as NoteValue);
      if (!existing || !old || old.deleted === true)
        return { status: "not_found" as const, id: input.id };
      const record = state.put(
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
        id: input.id,
        note: present(
          state,
          input.id,
          record,
          record.value as NoteValue,
          input.text,
        ),
      };
    }
    // The number and the note it numbers commit together.
    return committed(() => {
      const counter = readCounter(state, NOTE_COUNTER);
      const id = noteId(counter.last + 1);
      const [, record] = state.putMany([
        {
          key: NOTE_COUNTER,
          value: { last: counter.last + 1 },
          expectRevision: counter.revision,
        },
        { key: noteKey(id), value: fields([]), expectRevision: 0 },
      ]);
      if (!record) throw new Error("note was not written");
      return {
        status: "added" as const,
        id,
        note: present(state, id, record, record.value as NoteValue, input.text),
      };
    });
  },

  "memory.search": ({
    input,
    services,
  }: {
    input: {
      query: string;
      scope?: string;
      tag?: string;
      limit?: number;
      cursor?: string;
    };
    services: Services;
  }) => {
    const { state } = services;
    const wanted = [...new Set(terms(input.query).map(stem))];
    // A page looks at the newest SEARCH_WINDOW matching-scope notes below the cursor's bound. The
    // cursor continues inside the window (skip) and then on to the next older window, so every
    // note can be reached; the window is chosen after tombstones and filters are applied.
    const [bound = 0, skip = 0] = (input.cursor ?? "0:0")
      .split(":")
      .map(Number);
    // The window is the newest SEARCH_WINDOW records below the bound: that many are read, however
    // many the store holds. Forgotten notes and other scopes are dropped after reading.
    const records = notePage(state, {
      ...(bound === 0 ? {} : { before: bound }),
      limit: SEARCH_WINDOW,
      descending: true,
    });
    const oldest = records[records.length - 1];
    const older = records.length === SEARCH_WINDOW;
    const window = records.filter(
      (note) =>
        note.value.deleted !== true &&
        (input.scope === undefined || note.value.scope === input.scope) &&
        (input.tag === undefined || note.value.tags.includes(input.tag)),
    );
    const documents = window.map((note) => {
      const counts = new Map<string, number>();
      let length = 0;
      for (const term of terms(
        `${note.value.text} ${note.value.tags.join(" ")}`,
      )) {
        const key = stem(term);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        length += 1;
      }
      return { note, counts, length };
    });
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
          noteNumber(b.document.note.id) - noteNumber(a.document.note.id),
      );
    const limit = input.limit ?? DEFAULT_LIMIT;
    const next =
      skip + limit < scored.length
        ? `${bound}:${skip + limit}`
        : older && oldest
          ? `${noteNumber(oldest.id)}:0`
          : undefined;
    return {
      hits: scored.slice(skip, skip + limit).map(({ document, score }) => {
        const { note } = document;
        return {
          id: note.id,
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
      truncated: next !== undefined,
      ...(next === undefined ? {} : { next }),
    };
  },

  "memory.show": ({
    input,
    services,
  }: {
    input: { id: string; revision?: number };
    services: Services;
  }) => {
    const { state } = services;
    const record = state.get(noteKey(input.id));
    if (!record) return { status: "not_found" as const };
    const value = record.value as NoteValue;
    if (value.deleted === true) return { status: "forgotten" as const };
    if (input.revision === undefined || input.revision === record.revision)
      return {
        status: "found" as const,
        note: present(state, input.id, record, value, value.text),
      };
    const older = value.previous.find(
      (entry) => entry.revision === input.revision,
    );
    if (!older) return { status: "version_unavailable" as const };
    return {
      status: "found" as const,
      note: present(state, input.id, record, value, older.text),
    };
  },

  "memory.forget": ({
    input,
    services,
  }: {
    input: { id: string; expectRevision?: number };
    services: Services;
  }) => {
    const { state } = services;
    const key = noteKey(input.id);
    const existing = state.get(key);
    if (!existing) return { status: "not_found" as const, id: input.id };
    if ((existing.value as NoteValue).deleted === true)
      return { status: "already_forgotten" as const, id: input.id };
    state.put(
      key,
      { text: "", tags: [], links: [], previous: [], deleted: true },
      { expectRevision: input.expectRevision ?? existing.revision },
    );
    return { status: "forgotten" as const, id: input.id };
  },

  "memory.export": ({
    input,
    services,
  }: {
    input: { scope?: string; after?: number };
    services: Services;
  }) => {
    // Read one page of records after the cursor; forgotten and out-of-scope ones are passed over
    // but still move the cursor, so a long run of them never stalls a walk.
    const records = notePage(services.state, {
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
      examined = noteNumber(note.id);
    }
    const more = stopped || records.length === EXPORT_READ;
    return {
      format: "forge.memory.export/1" as const,
      count: chosen.length,
      truncated: more,
      ...(more && examined !== undefined ? { next: examined } : {}),
      notes: chosen.map((note) => ({
        id: note.id,
        revision: note.record.revision,
        ...(note.value.scope === undefined ? {} : { scope: note.value.scope }),
        tags: [...note.value.tags],
        links: [...note.value.links],
        text: {
          kind: "untrusted" as const,
          source: `memory:${note.id}`,
          text: note.value.text,
        },
      })),
    };
  },

  "memory.restore": ({
    input,
    services,
  }: {
    input: {
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
    const { state } = services;
    // One transaction for the whole page and the counter that must stay ahead of it.
    return committed(() => {
      let skipped = 0;
      const conflicts: string[] = [];
      const entries: BatchEntry[] = [];
      const queued = new Set<string>();
      let highest = 0;
      for (const note of input.notes) {
        const key = noteKey(note.id);
        highest = Math.max(highest, noteNumber(note.id));
        const existing = state.get(key);
        if (existing) {
          const old = existing.value as NoteValue;
          if (old.deleted !== true && old.text === note.text.text) skipped += 1;
          else conflicts.push(note.id);
          continue;
        }
        if (queued.has(key)) {
          conflicts.push(note.id);
          continue;
        }
        queued.add(key);
        entries.push({
          key,
          value: {
            text: note.text.text,
            ...(note.scope === undefined ? {} : { scope: note.scope }),
            tags: note.tags,
            links: note.links,
            previous: [],
          },
          expectRevision: 0,
        });
      }
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
