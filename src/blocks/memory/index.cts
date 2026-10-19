// forge/memory: project and device knowledge. One self-contained file, because the sync profile runs
// a block's entry alone: no imports at run time, no clock, no files, only the bound `state` client.
// Notes live in the device store (`device` context); decisions live in the project store.
import type { StateClient, StateRecord } from "../../contract/author.ts";

interface Services {
  readonly state: StateClient;
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
  readonly scope?: string;
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

const NOTE_PREFIX = "note/";
const NOTE_COUNTER = "meta/note-counter";
const DECISION_PREFIX = "decision/";
const DECISION_COUNTER = "meta/decision-counter";
const MAX_SCAN = 5000;
// The runtime stops a block after one second and refuses output over 1 MiB. A write costs a few
// milliseconds, so a restore takes few notes; an export chunk is never larger than a restore.
const CHUNK_NOTES = 50;
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
/** Hand out the next number for a counter; a competing writer that wins makes this retry. */
function claim(state: StateClient, key: string, floor: number): number {
  let last: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const current = state.get(key);
    const issued = current ? (current.value as { last: number }).last : 0;
    const next = Math.max(issued, floor) + 1;
    try {
      state.put(
        key,
        { last: next },
        { expectRevision: current?.revision ?? 0 },
      );
      return next;
    } catch (error) {
      if (!conflict(error)) throw error;
      last = error;
    }
  }
  throw last;
}
function raise(state: StateClient, key: string, number: number): void {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const current = state.get(key);
    const issued = current ? (current.value as { last: number }).last : 0;
    if (issued >= number) return;
    try {
      state.put(
        key,
        { last: number },
        { expectRevision: current?.revision ?? 0 },
      );
      return;
    } catch (error) {
      if (!conflict(error)) throw error;
    }
  }
}

function noteId(number: number): string {
  return `note-${number}`;
}
function noteNumber(id: string): number {
  return Number(id.slice("note-".length));
}
function noteKey(id: string): string {
  return `${NOTE_PREFIX}${noteNumber(id)}`;
}
function noteOf(record: StateRecord): { id: string; value: NoteValue } {
  return {
    id: noteId(Number(record.key.slice(NOTE_PREFIX.length))),
    value: record.value as NoteValue,
  };
}
/** Live notes in number order. `cap` bounds how many records are read; export reads them all. */
function liveNotes(
  state: StateClient,
  cap = Number.POSITIVE_INFINITY,
): {
  notes: { id: string; value: NoteValue; record: StateRecord }[];
  truncated: boolean;
} {
  const records = [...state.list(NOTE_PREFIX)].sort(
    (a, b) =>
      Number(a.key.slice(NOTE_PREFIX.length)) -
      Number(b.key.slice(NOTE_PREFIX.length)),
  );
  const notes = records
    .slice(0, cap)
    .map((record) => ({ ...noteOf(record), record }))
    .filter((note) => note.value.deleted !== true);
  return { notes, truncated: records.length > cap };
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
    const fields = (previous: readonly Version[]): NoteValue => ({
      text: input.text,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      tags: input.tags ?? [],
      links: input.links ?? [],
      previous,
    });
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
    const id = noteId(claim(state, NOTE_COUNTER, 0));
    const record = state.put(noteKey(id), fields([]), { expectRevision: 0 });
    return {
      status: "added" as const,
      id,
      note: present(state, id, record, record.value as NoteValue, input.text),
    };
  },

  "memory.search": ({
    input,
    services,
  }: {
    input: { query: string; scope?: string; tag?: string; limit?: number };
    services: Services;
  }) => {
    const { state } = services;
    const wanted = [...new Set(terms(input.query).map(stem))];
    const { notes, truncated } = liveNotes(state, MAX_SCAN);
    const candidates = notes.filter(
      (note) =>
        (input.scope === undefined || note.value.scope === input.scope) &&
        (input.tag === undefined || note.value.tags.includes(input.tag)),
    );
    const documents = candidates.map((note) => {
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
    return {
      hits: scored.slice(0, limit).map(({ document, score }) => {
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
      scanned: notes.length,
      truncated,
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
    const { notes } = liveNotes(services.state);
    const remaining = notes.filter(
      (note) =>
        noteNumber(note.id) > (input.after ?? 0) &&
        (input.scope === undefined || note.value.scope === input.scope),
    );
    // One chunk is what a single restore accepts and what the runtime lets one call return.
    const chosen: typeof remaining = [];
    let chars = 0;
    for (const note of remaining) {
      if (
        chosen.length >= CHUNK_NOTES ||
        (chosen.length > 0 && chars + note.value.text.length > CHUNK_CHARS)
      )
        break;
      chosen.push(note);
      chars += note.value.text.length;
    }
    const last = chosen[chosen.length - 1];
    const more = chosen.length < remaining.length;
    return {
      format: "forge.memory.export/1" as const,
      count: chosen.length,
      truncated: more,
      ...(more && last ? { next: noteNumber(last.id) } : {}),
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
    let added = 0;
    let skipped = 0;
    const conflicts: string[] = [];
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
      state.put(
        key,
        {
          text: note.text.text,
          ...(note.scope === undefined ? {} : { scope: note.scope }),
          tags: note.tags,
          links: note.links,
          previous: [],
        },
        { expectRevision: 0 },
      );
      added += 1;
    }
    raise(state, NOTE_COUNTER, highest);
    return { added, skipped, conflicts };
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
    const number = claim(state, DECISION_COUNTER, format.highest ?? 0);
    const id = formatId(format.idPattern, number);
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
    const record = state.put(`${DECISION_PREFIX}${number}`, value, {
      expectRevision: 0,
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
    const match = state
      .list(DECISION_PREFIX)
      .find((record) => decisionOf(record).id === input.id);
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
    const records = services.state
      .list(DECISION_PREFIX)
      .filter(
        (record) =>
          input.status === undefined ||
          decisionOf(record).status === input.status,
      )
      .sort((a, b) => decisionOf(a).number - decisionOf(b).number);
    const remaining = records.filter(
      (record) => decisionOf(record).number > (input.after ?? 0),
    );
    const page = remaining.slice(0, LIST_LIMIT);
    const lastPage = page[page.length - 1];
    const more = page.length < remaining.length;
    return {
      total: records.length,
      truncated: more,
      ...(more && lastPage ? { next: decisionOf(lastPage).number } : {}),
      decisions: page.map((record) => {
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
