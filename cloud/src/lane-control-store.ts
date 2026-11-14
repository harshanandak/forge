import {
  readLaneControl,
  transitionLaneControl,
  type LaneControl,
  type LaneControlGlobal,
  type LaneScope,
} from "../../src/blocks/work/lane-control.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import type { StateOwner } from "../../src/core/state/index.ts";
import type {
  FailureEnvelope,
  SuccessEnvelope,
} from "../../src/generated/types.ts";
import type { BatchEntry } from "../../src/ports/state.ts";
import { failure } from "../../src/surface/result.ts";

type Result =
  FailureEnvelope | (SuccessEnvelope & { readonly result: LaneControl });
const NS = "forge/work";
const GLOBAL = "lane-control:global";
const unavailable = () => failure("UNAVAILABLE", "Lane control is unavailable");
const invalid = () =>
  failure(
    "INPUT_INVALID",
    "Expected a canonical lane scope and device/session",
  );
const text = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  value.trim() === value &&
  !/[\p{Cc}]/u.test(value);
const canonical = (value: unknown): value is string =>
  text(value) && /^work-[1-9]\d*$/.test(value);

function scopeOf(value: unknown): LaneScope | undefined {
  if (typeof value !== "object" || value === null) return;
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== 1) return;
    const key = keys[0];
    if (key !== "id" && key !== "all") return;
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      return;
    const input: unknown = descriptor.value;
    if (key === "id" && canonical(input)) return { id: input };
    if (key === "all" && input === true) return { all: true };
  } catch {
    return;
  }
  return;
}

/** Internal to a single project authority; callers supply authenticated device/session identities. */
export class LaneControlStore {
  readonly #owner: StateOwner;
  readonly #project: string;

  constructor(owner: StateOwner, project: string) {
    this.#owner = owner;
    this.#project = project;
  }

  read(issueId?: string): Result {
    if (issueId !== undefined && !canonical(issueId)) return invalid();
    try {
      const global = this.#owner.get(NS, GLOBAL);
      const issue =
        issueId === undefined
          ? undefined
          : this.#owner.get(NS, `lane-control:${issueId}`);
      return readLaneControl(
        global?.value,
        issue?.value,
        issueId === undefined ? {} : { id: issueId },
      );
    } catch {
      return unavailable();
    }
  }

  stop(scope: unknown, device: string, session: string, now: string): Result {
    const target = scopeOf(scope);
    if (!target || !text(device) || !text(session)) return invalid();
    try {
      const global = this.#owner.get(NS, GLOBAL);
      // Only stop-all may establish a new authority history. Corruption is never bootstrapped.
      if (global === undefined && "id" in target) return unavailable();
      const initial: LaneControlGlobal = {
        version: 1,
        incarnation: crypto.randomUUID(),
        epoch: 0,
        resumeAllEpoch: 0,
        stopAll: null,
      };
      const issueKey = "id" in target ? `lane-control:${target.id}` : undefined;
      const issue =
        issueKey === undefined ? undefined : this.#owner.get(NS, issueKey);
      const transition = transitionLaneControl(
        global === undefined ? initial : global.value,
        issue?.value,
        { action: "stop", scope: target },
        { project: this.#project, policyIdentity: "lane.stop", now },
      );
      if (!transition.ok) return transition;
      const { candidate } = transition.result;
      const entries: BatchEntry[] = [
        {
          key: GLOBAL,
          value: candidate.global,
          expectRevision: global?.revision ?? 0,
        },
      ];
      if (issueKey !== undefined && candidate.issue !== undefined)
        entries.push({
          key: issueKey,
          value: candidate.issue,
          expectRevision: issue?.revision ?? 0,
        });
      entries.push({
        key: `lane-control:audit:${crypto.randomUUID()}`,
        expectRevision: 0,
        value: {
          version: 1,
          action: "stop",
          scope: target,
          device,
          session,
          at: now,
          incarnation: candidate.global.incarnation,
          epoch: candidate.global.epoch,
        },
      });
      // The global revision binds the exact epoch/incarnation read, including absence at bootstrap.
      // StateOwner checks every revision before applying any row, and rolls back audit failures.
      this.#owner.putMany(NS, entries, { kind: "agent", id: session });
      return readLaneControl(candidate.global, candidate.issue, target);
    } catch (error) {
      if (
        error instanceof ForgeFailure &&
        error.error.code === "REVISION_CONFLICT"
      )
        return failure(
          "INPUT_CONFLICT",
          "Lane control changed; read again before retrying",
        );
      return unavailable();
    }
  }
}
