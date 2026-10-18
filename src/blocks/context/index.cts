// forge/context: orientation and cross-harness handoff. One self-contained file (the sync profile
// runs a block's entry alone). A handoff record is what one session writes so another, possibly in
// another harness, can resume: where the work is, what is unfinished and what to do next.
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
interface Thread {
  readonly id: string;
  readonly path?: string;
  readonly state: "unresolved" | "resolved" | "outdated";
  readonly author?: string;
  readonly summary?: string;
}
interface Check {
  readonly name: string;
  readonly status: "PASS" | "FAIL" | "INCOMPLETE" | "NOT_EXECUTED";
  readonly ref?: string;
}
interface Lease {
  readonly subject: string;
  readonly holder: string;
  readonly generation: number;
  readonly expiresAt: string;
}
interface Uncommitted {
  readonly state: "clean" | "dirty";
  readonly base: string;
  readonly digest?: string;
  readonly files?: number;
}
interface HandoffValue {
  readonly seq: number;
  readonly head: string;
  readonly nextStep: string;
  readonly issue?: string;
  readonly run?: string;
  readonly uncommitted: Uncommitted;
  readonly pendingReview: readonly Thread[];
  readonly evidence: readonly Check[];
  readonly memory: readonly string[];
  readonly leases: readonly Lease[];
}
interface Current {
  readonly head: string;
  readonly uncommittedDigest?: string;
}

const SLOT_PREFIX = "handoff/slot-";
const SLOTS = 16;
const MAX_RETRIES = 8;
const DEFAULT_EARLIER = 3;

function neutralize(text: string): string {
  return text.split("⟦").join("(").split("⟧").join(")");
}
/** A handoff carries reviewers' words and an earlier agent's plan; the next agent reads data, not orders. */
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
function slots(state: StateClient): StateRecord[] {
  return [...state.list(SLOT_PREFIX)].sort(
      (a, b) =>
        (b.value as HandoffValue).seq - (a.value as HandoffValue).seq,
    );
}
function present(record: StateRecord) {
  const value = record.value as HandoffValue;
  const id = `handoff-${value.seq}`;
  const source = `context:${id}`;
  const unresolved = value.pendingReview.filter(
    (thread) => thread.state === "unresolved",
  ).length;
  return {
    id,
    seq: value.seq,
    at: record.updatedAt,
    by: { kind: record.updatedBy.kind, id: record.updatedBy.id },
    head: value.head,
    ...(value.issue === undefined ? {} : { issue: value.issue }),
    ...(value.run === undefined ? {} : { run: value.run }),
    uncommitted: { ...value.uncommitted },
    pendingReview: {
      unresolved,
      threads: value.pendingReview.map((thread) => ({
        id: thread.id,
        state: thread.state,
        ...(thread.path === undefined ? {} : { path: thread.path }),
        ...(thread.author === undefined ? {} : { author: thread.author }),
        ...(thread.summary === undefined
          ? {}
          : { summary: fence(thread.summary, `${source}:review:${thread.id}`) }),
      })),
    },
    evidence: value.evidence.map((check) => ({ ...check })),
    memory: [...value.memory],
    leases: value.leases.map((lease) => ({ ...lease })),
    nextStep: fence(value.nextStep, source, record.updatedAt),
  };
}

/** Is the work in the tree now the work the handoff described? */
function sameWork(
  recorded: Uncommitted,
  digest: string | undefined,
): "same" | "changed" | "unknown" {
  if (recorded.state === "clean") return digest === undefined ? "same" : "changed";
  if (digest === undefined) return "unknown";
  return digest === recorded.digest ? "same" : "changed";
}

module.exports = {
  "context.handoff": ({
    input,
    services,
  }: {
    input: {
      head: string;
      nextStep: string;
      issue?: string;
      run?: string;
      uncommitted: Uncommitted;
      pendingReview?: readonly Thread[];
      evidence?: readonly Check[];
      memory?: readonly string[];
      leases?: readonly Lease[];
    };
    services: Services;
  }) => {
    const { state } = services;
    let last: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      const newest = slots(state)[0];
      const seq = newest ? (newest.value as HandoffValue).seq + 1 : 1;
      const key = `${SLOT_PREFIX}${seq % SLOTS}`;
      const value: HandoffValue = {
        seq,
        head: input.head,
        nextStep: input.nextStep,
        ...(input.issue === undefined ? {} : { issue: input.issue }),
        ...(input.run === undefined ? {} : { run: input.run }),
        uncommitted: input.uncommitted,
        pendingReview: input.pendingReview ?? [],
        evidence: input.evidence ?? [],
        memory: input.memory ?? [],
        leases: input.leases ?? [],
      };
      try {
        // A slot is rewritten only by the writer who saw the slot's last revision, so two sessions
        // handing off at once cannot both take the same sequence number.
        const record = state.put(key, value, {
          expectRevision: state.get(key)?.revision ?? 0,
        });
        return { id: `handoff-${seq}`, seq, revision: record.revision };
      } catch (error) {
        if (!conflict(error)) throw error;
        last = error;
      }
    }
    throw last;
  },

  "context.show": ({
    input,
    services,
  }: {
    input: { current?: Current; earlier?: number };
    services: Services;
  }) => {
    const all = slots(services.state);
    const [latest, ...rest] = all;
    if (!latest)
      return {
        format: "forge.context/1" as const,
        latest: null,
        earlier: [],
        held: 0,
      };
    const shown = present(latest);
    const current = input.current;
    const check =
      current === undefined
        ? undefined
        : {
            head: current.head === shown.head ? ("same" as const) : ("moved" as const),
            uncommitted: sameWork(shown.uncommitted, current.uncommittedDigest),
          };
    return {
      format: "forge.context/1" as const,
      latest: shown,
      ...(check === undefined ? {} : { check }),
      earlier: rest.slice(0, input.earlier ?? DEFAULT_EARLIER).map((record) => {
        const value = record.value as HandoffValue;
        return {
          id: `handoff-${value.seq}`,
          seq: value.seq,
          at: record.updatedAt,
          head: value.head,
          ...(value.issue === undefined ? {} : { issue: value.issue }),
          nextStep: fence(value.nextStep, `context:handoff-${value.seq}`, record.updatedAt),
        };
      }),
      held: all.length,
    };
  },
};
