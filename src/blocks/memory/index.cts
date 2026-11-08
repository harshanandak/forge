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
  /** Absent once accepted. A never-accepted owner-tagged note is proposed, then accepted or rejected. */
  readonly status?: "proposed" | "rejected";
  /** A revision of an accepted note that waits for the owner; the note's own fields stay served. */
  readonly proposal?: Proposal;
  /** Revisions the owner rejected, kept for history. */
  readonly rejectedProposals?: readonly Proposal[];
}
/** A proposal as an export carries it: its text is an untrusted-text object. */
interface RestoredProposal {
  readonly text: { readonly text: string };
  readonly scope?: string;
  readonly tags: readonly string[];
  readonly links: readonly string[];
  readonly at: string;
}
interface Proposal {
  readonly text: string;
  readonly scope?: string;
  readonly tags: readonly string[];
  readonly links: readonly string[];
  readonly at: string;
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

function moveCopy(
  source: Source,
  existing: StateRecord,
  value: NoteValue,
  id: string,
): NoteValue {
  const stamps = shown(source.state, existing, value);
  return {
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
    from: qualified(id),
    ...(value.proposedForget === true ? { proposedForget: true as const } : {}),
    ...pending(value),
  };
}
/** An approved owner-tag removal replaces the note, so a stale proposal must not come back. */
function withoutProposal(value: NoteValue): NoteValue {
  const { proposal: _proposal, ...rest } = value;
  return rest;
}
/** What a copy must keep so a move never turns a proposal into an accepted note. */
function pending(value: NoteValue) {
  return {
    ...(value.status === undefined ? {} : { status: value.status }),
    ...(value.proposal === undefined ? {} : { proposal: value.proposal }),
    ...(value.rejectedProposals === undefined
      ? {}
      : { rejectedProposals: value.rejectedProposals }),
  };
}

function settledTransfer(
  target: Source,
  id: string,
  sourceRevision: number,
  recorded: Transfer | undefined,
  current: StateRecord | undefined,
  keep = false,
):
  | { readonly at: number; readonly settled: true }
  | { readonly conflict: string }
  | undefined {
  if (!recorded) return undefined;
  const at = recorded.number;
  // A transfer of another source revision is a different transfer, never a retry.
  if (recorded.sourceRevision !== sourceRevision)
    return {
      conflict: `${qualified(id)} was copied to ${idIn(target, at)} from revision ${recorded.sourceRevision}, not ${sourceRevision}; nothing was written`,
    };
  // The same transfer again. Someone edited or forgot the copy since: it is never redone,
  // and a move retires its source only while the copy still holds the note.
  if (current && current.revision !== recorded.revision) {
    const live = (current.value as NoteValue).deleted !== true;
    return keep || live
      ? { at, settled: true }
      : {
          conflict: `${idIn(target, at)} was forgotten after ${qualified(id)} was copied there; nothing was written`,
        };
  }
  if (current) return { at, settled: true };
  return undefined;
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
function movedPointer(to: string) {
  const project = parseRef(to)?.project;
  return {
    status: "moved" as const,
    to,
    next: `Run forge memory show ${to} from a host ${project ? `inside project ${project}` : "on this device"}.`,
  };
}
/** Follow only into this host's project, and never resolve a second tombstone. */
function followMoved(source: Source, record: StateRecord, project?: Source) {
  const original = noteOf(source, record);
  const to = original.value.movedTo;
  if (!original.value.deleted || to === undefined)
    return { source, ...original };
  const ref = parseRef(to);
  if (
    !project ||
    ref?.level !== "project" ||
    project.prefix !== `project/${ref.project}`
  )
    return movedPointer(to);
  const destination = project.state.get(noteKey(ref.number));
  if (!destination) return movedPointer(to);
  const note = noteOf(project, destination);
  if (note.value.deleted && note.value.movedTo !== undefined)
    return movedPointer(note.value.movedTo);
  return { source: project, ...note, movedFrom: original.id };
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
  movedFrom?: string,
) {
  return {
    id,
    ...label(source),
    revision: record.revision,
    ...(value.scope === undefined ? {} : { scope: value.scope }),
    tags: [...value.tags],
    links: qualifiedLinks(value.links),
    ...(value.from === undefined ? {} : { from: value.from }),
    ...(movedFrom === undefined ? {} : { movedFrom }),
    ...(value.proposedForget === true ? { proposedForget: true as const } : {}),
    ...(value.status === undefined ? {} : { status: value.status }),
    ...(value.proposal === undefined
      ? {}
      : { proposal: shownProposal(value.proposal, id) }),
    ...(value.rejectedProposals?.length
      ? {
          rejectedProposals: value.rejectedProposals.map((entry) =>
            shownProposal(entry, id),
          ),
        }
      : {}),
    text: fence(text, `memory:${id}`, record.updatedAt),
    updatedAt: record.updatedAt,
    ...dates(source.state, record, value),
    versions,
    ...audit(value.approval, `memory:${id}`),
  };
}
function shownProposal(proposal: Proposal, id: string) {
  return {
    text: fence(proposal.text, `memory:${id}:proposal`, proposal.at),
    ...(proposal.scope === undefined ? {} : { scope: proposal.scope }),
    tags: [...proposal.tags],
    links: qualifiedLinks(proposal.links),
    at: proposal.at,
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

interface DecideItem {
  readonly id: string;
  readonly revision: number;
  readonly text?: string;
}
interface DecideArgs {
  input: { items: DecideItem[]; approval?: Approval };
  services: Services;
}
/**
 * The owner's decision on proposed notes and revisions. Accept makes a proposal the served note;
 * reject closes it and keeps it readable. Both need the owner's approval, checked before any read.
 * The runtime relays that approval for exactly these items, so each names the note revision and the
 * proposed text the owner was shown: a note edited since refuses the whole call before any write,
 * and the write itself is fenced to that revision.
 */
async function decide(
  { input, services }: DecideArgs,
  decision: "accept" | "reject",
) {
  const approval = approved(
    input.approval,
    `memory.${decision}`,
    "proposed notes",
  );
  const results: { id: string; status: string }[] = [];
  const planned: {
    id: string;
    source: Source;
    key: string;
    existing: StateRecord;
    old: NoteValue;
  }[] = [];
  // Every item is checked, but each note is reported and written once, under its resolved id
  // (device/note-1 and device/note-01 are the same note).
  const seen = new Set<string>();
  const report = (id: string, status: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    results.push({ id, status });
  };
  const written = new Set<string>();
  for (const item of input.items) {
    const requested = qualified(item.id);
    const found = await sourceFor(services, requested);
    if (unreached(found)) {
      report(requested, "not_found");
      continue;
    }
    const { source, number } = found;
    const id = idIn(source, number);
    if (source.readOnly) {
      report(id, "read_only");
      continue;
    }
    const key = noteKey(number);
    const existing = source.state.get(key);
    const old = existing && (existing.value as NoteValue);
    if (!existing || !old || old.deleted === true) {
      report(id, "not_found");
      continue;
    }
    if (old.status !== "proposed" && old.proposal === undefined) {
      report(id, "not_proposed");
      continue;
    }
    const proposed = old.proposal?.text ?? old.text;
    if (
      existing.revision !== item.revision ||
      (item.text === undefined
        ? decision === "accept"
        : neutralize(item.text) !== neutralize(proposed))
    )
      fail(
        "PROPOSAL_CHANGED",
        `${id} is at revision ${existing.revision}, not the revision ${item.revision} the owner approved, or its proposed text differs; nothing was written. Show it again, ask the owner about what it says now, and retry with that revision and text.`,
      );
    if (written.has(id)) continue;
    written.add(id);
    planned.push({ id, source, key, existing, old });
  }
  const at = approval.at;
  for (const { id, source, key, existing, old } of planned) {
    const { status: _status, proposal, ...kept } = old;
    const base: NoteValue = {
      ...kept,
      textRevision: old.textRevision ?? existing.revision,
    };
    let value: NoteValue;
    if (decision === "reject")
      value =
        proposal === undefined
          ? { ...base, status: "rejected" }
          : {
              ...base,
              // A note that was never accepted stays unserved when its pending revision is rejected.
              ...(old.status === undefined ? {} : { status: old.status }),
              rejectedProposals: [
                ...(old.rejectedProposals ?? []),
                proposal,
              ].slice(-MAX_VERSIONS),
            };
    else if (proposal === undefined)
      value = { ...base, approval, versionApproval: approval };
    else {
      const stamps = shown(source.state, existing, old);
      const { textRevision: _revision, scope: _scope, ...rest } = base;
      value = {
        ...rest,
        text: proposal.text,
        ...(proposal.scope === undefined ? {} : { scope: proposal.scope }),
        tags: proposal.tags,
        links: proposal.links,
        changedAt: at,
        textAt: at,
        previous: versionsOf(existing, old)
          .map((version, i) => ({
            ...version,
            text: old.previous[i]?.text ?? old.text,
            at: stamps[i]!.at,
          }))
          .slice(-MAX_VERSIONS),
        approval,
        versionApproval: approval,
        // Moves keep text version numbers while the destination store starts at revision one.
        ...((old.textRevision ?? 0) > existing.revision
          ? { textRevision: old.textRevision! + 1 }
          : {}),
      };
    }
    try {
      source.state.put(key, value, { expectRevision: existing.revision });
    } catch (error) {
      if (!conflict(error)) throw error;
      results.push({ id, status: "conflict" });
      continue;
    }
    results.push({
      id,
      status: decision === "accept" ? "accepted" : "rejected",
    });
  }
  return { results };
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
    let waiting = 0;
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
          // Proposed notes and revisions wait for the owner: they are counted, never served.
          if (value.proposal !== undefined || value.status === "proposed")
            waiting += 1;
          if (value.status !== undefined) continue;
          const noteScope =
            value.scope ??
            (source.level === "project" ? scope : undefined) ??
            "general";
          const countScope =
            source.level === "project" && !counts.has(noteScope)
              ? scope
              : noteScope;
          const count = counts.get(countScope);
          if (count !== undefined) counts.set(countScope, count + 1);
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
        ...(waiting === 0
          ? {}
          : {
              proposed: {
                count: waiting,
                message:
                  waiting === 1
                    ? "1 proposed note awaits owner review"
                    : `${waiting} proposed notes await owner review`,
              },
            }),
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
      let jsonBytes = 0;
      for (const character of text) {
        const point = character.codePointAt(0)!;
        const bytes =
          point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
        utf8Bytes += bytes;
        // Count JSON's escaped payload without allocating and scanning an encoded copy.
        jsonBytes +=
          point === 0x22 || point === 0x5c
            ? 2
            : point < 0x20
              ? point === 8 ||
                point === 9 ||
                point === 10 ||
                point === 12 ||
                point === 13
                ? 2
                : 6
              : point >= 0xd800 && point <= 0xdfff
                ? 6
                : bytes;
        characters++;
      }
      return { utf8Bytes, characters, jsonBytes };
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
      movedFrom?: string;
      revision: number;
      scope: string;
      reasons: string[];
    };
    const candidates: (Selection & {
      line: string;
      number: number;
      source: number;
    })[] = [];
    const byId = new Map<string, Selection>();
    const moved: (ReturnType<typeof movedPointer> & { id: string })[] = [];
    for (const [sourceIndex, source] of sources.entries()) {
      let after = 0;
      for (;;) {
        const records = notePage(source, {
          after,
          limit: LIST_LIMIT,
          descending: false,
        });
        for (const original of records) {
          const resolved =
            original.value?.deleted && ids.has(original.id)
              ? followMoved(source, original.record, project)
              : { source, ...original };
          if ("status" in resolved) {
            moved.push({ id: original.id, ...resolved });
            continue;
          }
          const note = resolved;
          const noteSource = resolved.source;
          const movedFrom =
            "movedFrom" in resolved && typeof resolved.movedFrom === "string"
              ? resolved.movedFrom
              : undefined;
          if (movedFrom !== undefined)
            ids.set(
              note.id,
              Math.min(ids.get(note.id) ?? Infinity, ids.get(movedFrom)!),
            );
          const value = note.value as Partial<NoteValue> | null;
          if (
            !value ||
            typeof value.text !== "string" ||
            value.deleted === true ||
            value.status !== undefined
          )
            continue;
          const noteScope =
            value.scope ?? (noteSource.level === "project" ? scope : "general");
          if (
            noteSource.level === "device" &&
            noteScope !== "general" &&
            noteScope !== scope
          )
            continue;
          const reasons = [
            ...(ids.has(note.id) ? ["asked"] : []),
            ...(value.tags ?? []).filter(
              (tag) =>
                tag.toLowerCase().startsWith("on:") &&
                words.has(tag.slice(3).toLowerCase()),
            ),
          ];
          if (!reasons.length) continue;
          const existing = byId.get(note.id);
          if (existing) {
            if (movedFrom !== undefined) existing.movedFrom = movedFrom;
            continue;
          }
          const at = dates(noteSource.state, note.record, note.value).createdAt;
          const updated = contentTime(
            noteSource.state,
            note.record,
            note.value,
          );
          const text = value.text.replace(/[\s\u0085]+/gu, " ").trim();
          const line = `- [${noteScope}] ${note.id} (created ${at.slice(0, 10)}${updated === at ? "" : `, updated ${updated.slice(0, 10)}`}) ${text}`;
          candidates.push({
            id: note.id,
            ...(movedFrom === undefined ? {} : { movedFrom }),
            revision: note.record.revision,
            scope: noteScope,
            reasons,
            line,
            number: note.number,
            source: noteSource.level === "project" ? 1 : sourceIndex,
          });
          byId.set(note.id, candidates.at(-1)!);
        }
        const last = records.at(-1);
        if (records.length < LIST_LIMIT || !last) break;
        after = last.number;
      }
    }
    moved.sort((a, b) => ids.get(a.id)! - ids.get(b.id)!);
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
          ...(note.movedFrom === undefined
            ? {}
            : { movedFrom: note.movedFrom }),
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
        ...(note.movedFrom === undefined ? {} : { movedFrom: note.movedFrom }),
        revision: note.revision,
        scope: note.scope,
      };
      if (seen.has(`${note.id}@${note.revision}`)) {
        omit(note, "seen");
        continue;
      }
      const line = fence(note.line, "memory:attach").text;
      const lineSize = measure(line);
      const size = lineSize.utf8Bytes + (lines.length ? 1 : 0);
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
      const responseSize =
        lineSize.jsonBytes +
        measure(
          JSON.stringify([
            "",
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
    const packetSize = measure(packet.text);
    return {
      text: packet,
      receipt: {
        selected,
        ...(moved.length ? { moved } : {}),
        omitted,
        omittedCount,
        packet: {
          utf8Bytes: packetSize.utf8Bytes,
          characters: packetSize.characters,
          characterUnit: "Unicode code points",
        },
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
        ...(kept === undefined ? {} : pending(kept)),
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
      // An owner tag never reaches an accepted note on an agent's say-so, so nothing inline (not
      // even an owner approval, which only the relayed accept can verify) skips the owner.
      const newTags = input.tags ?? old.tags;
      const taggedNow = ownerTag(
        newTags.filter((tag) => !old.tags.includes(tag)),
        config,
      );
      // Removing one owner tag never lets changed text skip the owner while another owner tag stays.
      if (
        old.status === undefined &&
        (taggedNow !== undefined ||
          (ownerTag(old.tags, config) !== undefined &&
            input.text !== old.text &&
            (removed === undefined || ownerTag(newTags, config) !== undefined)))
      ) {
        const scope =
          input.scope === undefined ? old.scope : (input.scope ?? undefined);
        const waiting: NoteValue = {
          ...old,
          textRevision: old.textRevision ?? existing.revision,
          proposal: {
            text: input.text,
            ...(scope === undefined ? {} : { scope }),
            tags: newTags,
            links: qualifiedLinks(input.links ?? old.links),
            at,
          },
        };
        const record = source.state.put(key, waiting, {
          expectRevision: input.expectRevision ?? existing.revision,
        });
        return {
          status: "updated" as const,
          id: editing,
          note: present(source, editing, record, waiting, old.text),
          notice: `This change waits for the owner. The accepted text and tags stay served until the owner accepts it with memory.accept: copy id, revision and the proposed text from memory.show ${editing} into items, then ask the owner and follow the approval request it returns.`,
        };
      }
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
          ...(removed === undefined ? old : withoutProposal(old)),
          ...dates(source.state, existing, old),
          changedAt: contentTime(source.state, existing, old),
        },
      );
      if (approval !== undefined) Object.assign(value, { approval });
      if (removed !== undefined)
        Object.assign(value, { versionApproval: approval });
      // An edit to a rejected owner-tagged note puts the corrected note back in front of the owner.
      const resubmitted =
        old.status === "rejected" && ownerTag(value.tags, config) !== undefined;
      if (resubmitted) Object.assign(value, { status: "proposed" });
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
        ...(resubmitted
          ? {
              notice: `${editing} was rejected and is proposed again with this text. It waits for the owner; memory.accept needs id, revision and text from memory.show ${editing}.`,
            }
          : {}),
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
      // An owner tag never reaches the served rules on an agent's say-so: the note starts proposed
      // and only the owner's relayed memory.accept activates it, whatever approval the add carries.
      const tag = ownerTag(value.tags, config);
      const stored: NoteValue =
        tag === undefined ? value : { ...value, status: "proposed" };
      const expected = canonical(stored);
      const [, record] = target.state.putMany([
        {
          key: NOTE_COUNTER,
          value: { last: number },
          expectRevision: counter.revision,
        },
        {
          key: noteKey(number),
          value: stored,
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
        ...(tag === undefined
          ? {}
          : {
              notice: `${id} has the owner tag ${tag}, so it waits for the owner and is not served as a rule yet. The owner accepts it with memory.accept: copy id, revision and text from memory.show ${id} into items, then ask the owner and follow the approval request it returns.`,
            }),
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
            (input.scope === undefined ||
              note.value.scope === input.scope ||
              note.value.proposal?.scope === input.scope) &&
            (input.tag === undefined ||
              note.value.tags.includes(input.tag) ||
              note.value.proposal?.tags.includes(input.tag) === true),
        )
        .map((note) => {
          const counts = new Map<string, number>();
          let length = 0;
          for (const term of terms(
            `${note.value.text} ${note.value.tags.join(" ")} ${note.value.proposal?.text ?? ""} ${note.value.proposal?.tags.join(" ") ?? ""}`,
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
          ...(note.value.status === undefined
            ? {}
            : { status: note.value.status }),
          ...(note.value.proposal === undefined
            ? {}
            : { pendingProposal: true as const }),
          snippet: fence(
            snippet(
              note.value.proposal !== undefined &&
                !terms(note.value.text).some((term) =>
                  wanted.includes(stem(term)),
                )
                ? note.value.proposal.text
                : note.value.text,
              wanted,
            ),
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
    const initial = found.source.state.get(noteKey(found.number));
    if (!initial) return { status: "not_found" as const };
    const resolved = followMoved(
      found.source,
      initial,
      (initial.value as NoteValue).movedTo !== undefined &&
        services.levels.inProject
        ? await ownProject(services)
        : undefined,
    );
    if ("status" in resolved) return resolved;
    const { source, record, value, id } = resolved;
    const movedFrom = "movedFrom" in resolved ? resolved.movedFrom : undefined;
    if (value.deleted === true)
      return value.movedTo === undefined
        ? {
            status: "forgotten" as const,
            ...audit(value.approval, `memory:${qualified(input.id)}`),
          }
        : movedPointer(value.movedTo);
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
          id,
          record,
          value,
          value.text,
          shown(source.state, record, value),
          movedFrom,
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
        id,
        record,
        value,
        older.text,
        shown(source.state, record, value),
        movedFrom,
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

  "memory.move": async function move({
    input,
    services,
    deadline,
  }: {
    input:
      | {
          id: string;
          to: Level;
          expectRevision: number;
          keep?: boolean;
        }
      | {
          scope: string;
          to: "project";
          limit?: number;
        };
    services: Services;
    deadline?: number;
  }): Promise<object> {
    if ("scope" in input) {
      const limit = input.limit ?? 25;
      const reserveMs =
        deadline === undefined
          ? 1_000
          : Math.max(1_000, (deadline - Date.now()) / 10);
      const target = await writeTarget(services, "project");
      const source = deviceSource(services.state);
      const scope = input.scope;
      let complete = false;
      let slowestPageMs = 0;
      let slowestReadMs = 0;
      let records: ReturnType<typeof notePage> = [];
      let index = 0;
      let after = 0;
      let end = false;
      const moved: { id: string; to: string }[] = [];
      let stopped: { id: string; code: string } | undefined;
      let slowestMoveMs = 0;
      // Replaying transfer markers does not measure the cost of a fresh destination write.
      let probed = false;
      // Buffered notes need both the marker re-check and the pre-retirement destination read pass.
      const affordable = (overhead = slowestPageMs + reserveMs) => {
        if (deadline === undefined) return 25;
        const left = deadline - Date.now();
        return moved.length === 0
          ? Number(left >= Math.max(1_000, slowestMoveMs))
          : Math.max(
              0,
              Math.floor(
                (left - overhead) /
                  Math.max(1, slowestMoveMs + 2 * slowestReadMs),
              ),
            );
      };
      for (;;) {
        const size = Math.min(probed ? 25 : 1, limit - moved.length);
        const group: ReturnType<typeof notePage> = [];
        let irregular: ReturnType<typeof notePage>[number] | undefined;
        let deferred = false;
        for (;;) {
          const readPage = index === records.length;
          if (readPage && end) {
            complete = moved.length === 0;
            break;
          }
          const note = readPage ? undefined : records[index]!;
          if (
            note &&
            (note.value.deleted === true || note.value.scope !== scope)
          ) {
            index += 1;
            continue;
          }
          if (note && group.length === size) break;
          const first = !readPage && moved.length === 0;
          const needed =
            (readPage ? slowestPageMs : slowestReadMs) +
            group.length * (slowestMoveMs + 2 * slowestReadMs) +
            (first ? 1_000 : reserveMs);
          const collected = Date.now();
          const left = deadline === undefined ? Infinity : deadline - collected;
          if (first ? left < needed : left <= needed) {
            deferred = true;
            break;
          }
          if (readPage) {
            records = notePage(source, {
              after,
              limit: LIST_LIMIT,
              descending: false,
            });
            index = 0;
            after = records.at(-1)?.number ?? after;
            end = records.length < LIST_LIMIT;
            slowestPageMs = Math.max(slowestPageMs, Date.now() - collected);
          } else if (note) {
            const current = source.state.get(note.record.key);
            const regular =
              current &&
              current.revision === note.record.revision &&
              (current.value as NoteValue).deleted !== true &&
              !target.state.get(`${TRANSFER_PREFIX}${note.id}`);
            slowestReadMs = Math.max(slowestReadMs, Date.now() - collected);
            if (!regular) {
              irregular = note;
              break;
            }
            group.push(note);
            index += 1;
          }
          if (group.length === size && size > 0) break;
        }
        const fresh = group.length > 0;
        if (!fresh) {
          if (!irregular) break;
          group.push(irregular);
          index += 1;
        }
        const trim = (count: number) => {
          if (count >= group.length) return;
          group.length = count;
          // The next call scans from zero and finds every deferred live source again.
          deferred = true;
        };
        trim(affordable());
        if (group.length === 0) break;
        const started = Date.now();
        let failedNote = group[0]!;
        try {
          const placed =
            group.length === 1
              ? undefined
              : committed(() => {
                  // A competing transfer must be reconciled through the single-note path.
                  if (
                    group.some((note) =>
                      target.state.get(`${TRANSFER_PREFIX}${note.id}`),
                    )
                  )
                    return undefined;
                  const counter = readCounter(target.state, NOTE_COUNTER);
                  const entries: BatchEntry[] = [];
                  const destinations = group.map((note, i) => {
                    const at = counter.last + i + 1;
                    entries.push(
                      {
                        key: noteKey(at),
                        value: moveCopy(
                          source,
                          note.record,
                          note.value,
                          note.id,
                        ),
                        expectRevision: 0,
                      },
                      {
                        key: `${TRANSFER_PREFIX}${note.id}`,
                        value: {
                          number: at,
                          revision: 1,
                          sourceRevision: note.record.revision,
                        } satisfies Transfer,
                        expectRevision: 0,
                      },
                    );
                    return idIn(target, at);
                  });
                  trim(affordable());
                  if (group.length === 0) return [];
                  target.state.putMany([
                    {
                      key: NOTE_COUNTER,
                      value: { last: counter.last + group.length },
                      expectRevision: counter.revision,
                    },
                    ...entries.slice(0, group.length * 2),
                  ]);
                  return destinations.slice(0, group.length);
                });
          let retired = 0;
          if (placed) {
            const tombstones: BatchEntry[] = [];
            for (const [i, note] of group.entries()) {
              const checked = Date.now();
              const recorded = target.state.get(`${TRANSFER_PREFIX}${note.id}`)
                ?.value as Transfer | undefined;
              const current = recorded
                ? target.state.get(noteKey(recorded.number))
                : undefined;
              const settled = settledTransfer(
                target,
                note.id,
                note.record.revision,
                recorded,
                current,
              );
              slowestReadMs = Math.max(slowestReadMs, Date.now() - checked);
              if (
                !settled ||
                !("at" in settled) ||
                idIn(target, settled.at) !== placed[i]
              )
                break;
              tombstones.push({
                key: note.record.key,
                value: { ...TOMBSTONE, movedTo: placed[i] },
                expectRevision: note.record.revision,
              });
            }
            // Retired sources cannot be deferred: reserve their read-back before committing them.
            trim(affordable(reserveMs));
            tombstones.length = Math.min(tombstones.length, group.length);
            try {
              if (tombstones.length === 1) {
                const tombstone = tombstones[0]!;
                source.state.put(tombstone.key, tombstone.value, {
                  expectRevision: tombstone.expectRevision,
                });
              } else if (tombstones.length > 1)
                source.state.putMany(tombstones);
              retired = tombstones.length;
            } catch (error) {
              if (!conflict(error)) throw error;
              // Reconcile every destination again through single-note moves after a failed batch.
            }
          }
          for (const [i, note] of group.entries()) {
            failedNote = note;
            const noteStarted = Date.now();
            const single = !placed || i >= retired;
            if (single && stopped) break;
            if (single && affordable(reserveMs) === 0) {
              deferred = true;
              break;
            }
            const to = single
              ? (
                  (await move({
                    input: {
                      id: note.id,
                      to: "project",
                      expectRevision: note.record.revision,
                    },
                    services,
                  })) as { to: string }
                ).to
              : placed[i]!;
            if (single && (!to || !to.startsWith(`${target.prefix}/`))) {
              stopped ??= { id: note.id, code: "VERIFY_FAILED" };
              break;
            }
            moved.push({ id: note.id, to });
            const ref = parseRef(to);
            const destination =
              ref?.level === "project" &&
              target.prefix === `project/${ref.project}`
                ? target.state.get(noteKey(ref.number))
                : undefined;
            const tombstone = source.state.get(note.record.key)?.value as
              NoteValue | undefined;
            const value = destination?.value as NoteValue | undefined;
            const drifted = (note: (typeof group)[number], to: string) =>
              !value ||
              value.deleted === true ||
              value.scope !== input.scope ||
              value.text !== note.value.text ||
              canonical(value.tags) !== canonical(note.value.tags) ||
              canonical(value.links) !==
                canonical(qualifiedLinks(note.value.links)) ||
              tombstone?.deleted !== true ||
              tombstone.movedTo !== to;
            if (drifted(note, to))
              stopped ??= { id: note.id, code: "VERIFY_FAILED" };
            if (fresh) probed = true;
            slowestMoveMs = Math.max(slowestMoveMs, Date.now() - noteStarted);
            if (single && stopped) break;
          }
          slowestMoveMs = Math.max(
            slowestMoveMs,
            (Date.now() - started) / Math.max(1, group.length),
          );
        } catch (error) {
          const code = (error as { error?: { code?: string } } | null)?.error
            ?.code;
          if (code !== "REVISION_CONFLICT" && code !== "TRANSFER_CONFLICT")
            throw error;
          stopped = { id: failedNote.id, code };
        }
        if (stopped || deferred) break;
      }
      if (!complete && moved.length === 0)
        fail(
          stopped?.code ?? "INSUFFICIENT_BUDGET",
          stopped
            ? `Scope move stopped at ${stopped.id}; resolve ${stopped.code} before retrying`
            : 'Scope move made no progress within its budget. Increase blocks.memory.operationTimeouts["memory.move"] in .forge/config.yaml and any lower runtime.timeoutMs or embedding timeout ceiling, then retry.',
        );
      return {
        status: "moved" as const,
        moved,
        complete,
        ...(stopped ? { stopped } : {}),
        ...(!complete
          ? {
              next: `forge memory move --scope ${input.scope} --to project --limit ${limit}`,
            }
          : {}),
      };
    }
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
    const copy = moveCopy(source, existing, value, input.id);
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
        const settled = settledTransfer(
          target,
          input.id,
          existing.revision,
          recorded,
          current,
          input.keep === true,
        );
        if (settled) return settled;
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
        // A note weighs its text and every proposal it carries, so a long history cannot push a page over.
        const weight =
          note.value.text.length +
          [
            ...(note.value.proposal ? [note.value.proposal] : []),
            ...(note.value.rejectedProposals ?? []),
          ].reduce((sum, entry) => sum + entry.text.length, 0);
        if (
          chosen.length >= CHUNK_NOTES ||
          (chosen.length > 0 && chars + weight > CHUNK_CHARS)
        ) {
          stopped = true;
          break;
        }
        chosen.push(note);
        chars += weight;
      }
      examined = note.number;
    }
    const more = stopped || records.length === EXPORT_READ;
    // A bundle that carries proposal state is a newer format, so a restorer that predates it
    // refuses the bundle instead of reading a proposed note as an accepted one.
    const waiting = chosen.some(
      (note) =>
        note.value.status !== undefined ||
        note.value.proposal !== undefined ||
        (note.value.rejectedProposals?.length ?? 0) > 0,
    );
    const proposalOut = (proposal: Proposal, id: string) => ({
      text: {
        kind: "untrusted" as const,
        source: `memory:${id}:proposal`,
        text: proposal.text,
      },
      ...(proposal.scope === undefined ? {} : { scope: proposal.scope }),
      tags: [...proposal.tags],
      links: qualifiedLinks(proposal.links),
      at: proposal.at,
    });
    return {
      format: waiting
        ? ("forge.memory.export/3" as const)
        : ("forge.memory.export/2" as const),
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
        ...(note.value.status === undefined
          ? {}
          : { status: note.value.status }),
        ...(note.value.proposal === undefined
          ? {}
          : { proposal: proposalOut(note.value.proposal, note.id) }),
        ...(note.value.rejectedProposals?.length
          ? {
              rejectedProposals: note.value.rejectedProposals.map((entry) =>
                proposalOut(entry, note.id),
              ),
            }
          : {}),
      })),
    };
  },

  "memory.restore": async ({
    input,
    config = {},
    services,
  }: {
    input: {
      format:
        | "forge.memory.export/1"
        | "forge.memory.export/2"
        | "forge.memory.export/3";
      level?: Level;
      project?: ProjectIdentity;
      approval?: Approval;
      notes: readonly {
        id: string;
        scope?: string;
        tags: readonly string[];
        links: readonly string[];
        text: { text: string };
        status?: "proposed" | "rejected";
        proposal?: RestoredProposal;
        rejectedProposals?: readonly RestoredProposal[];
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
        // A note is either never accepted (status) or accepted with a pending revision (proposal).
        if (note.status !== undefined && note.proposal !== undefined) {
          conflicts.push(id);
          continue;
        }
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
          adding.flatMap(({ note }) => [
            ...note.tags,
            ...(note.proposal?.tags ?? []),
          ]),
          config,
        ),
      );
      // Restore approval covers the notes as they were exported. A proposed or rejected note, or a
      // pending revision, comes back in the same state and without approval: restoring never
      // accepts what the owner has not accepted.
      const restoredProposal = (entry: RestoredProposal): Proposal => ({
        text: entry.text.text,
        ...(entry.scope === undefined ? {} : { scope: entry.scope }),
        tags: entry.tags,
        links: relinked(entry.links, restored),
        at: entry.at,
      });
      // A bundle's own fields are never proof that the owner accepted a note: a new owner-tagged
      // note comes back proposed, whatever status the bundle claims, and only memory.accept serves it.
      let proposals = 0;
      for (const { key, note } of adding) {
        const ownerTagged = ownerTag(note.tags, config) !== undefined;
        const status =
          note.status === "rejected"
            ? "rejected"
            : ownerTagged || note.status === "proposed"
              ? "proposed"
              : undefined;
        if (ownerTagged && status === "proposed") proposals += 1;
        entries.push({
          key,
          value: {
            text: note.text.text,
            createdAt: approval.at,
            changedAt: approval.at,
            textAt: approval.at,
            ...(status === undefined
              ? { versionApproval: approval, approval }
              : { status }),
            ...(note.scope === undefined ? {} : { scope: note.scope }),
            tags: note.tags,
            links: relinked(note.links, restored),
            previous: [],
            // A pending revision cannot ride on a note that was never accepted.
            ...(note.proposal === undefined || status !== undefined
              ? {}
              : { proposal: restoredProposal(note.proposal) }),
            ...(note.rejectedProposals?.length
              ? {
                  rejectedProposals:
                    note.rejectedProposals.map(restoredProposal),
                }
              : {}),
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
      return {
        added,
        skipped,
        conflicts,
        ...(proposals === 0
          ? {}
          : {
              notice: `${proposals} owner-tagged note${proposals === 1 ? "" : "s"} restored as proposal${proposals === 1 ? "" : "s"}; accept them with memory.accept.`,
            }),
      };
    });
  },

  "memory.accept": (args: DecideArgs) => decide(args, "accept"),
  "memory.reject": (args: DecideArgs) => decide(args, "reject"),

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
