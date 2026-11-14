import { ForgeFailure } from "../../contract/failure.ts";
import { resolveOutside } from "../../assembly/providers.ts";
import type { TrackerItem } from "../../generated/types.ts";
import type {
  AmbientContext,
  StateRecord,
  LeaseRecord,
} from "../../generated/types.ts";
import type {
  FilesService,
  ProcessService,
  EnvironmentService,
} from "../../assembly/providers.ts";
import entry from "./entry.cts";
import type { StateClient } from "../../ports/state.ts";
import {
  boundLaneKey,
  readBoundLane,
  validBoundProgress,
  type BoundProgress,
  type BoundProject,
  type BoundLaneRecord,
} from "./bound-lane-state.ts";

export const BOUND_LANES: ReadonlySet<string> = new Set(
  ["start", "show", "status", "next", "record", "close", "release"].map(
    (verb) => `lane.${verb}`,
  ),
);
type ReadIssue = (id: string) => Promise<TrackerItem>;

export async function boundLaneRead(
  op: string,
  input: { readonly id?: string },
  project: BoundProject,
  state: Pick<StateClient, "get" | "list"> | undefined,
  issue: ReadIssue,
): Promise<unknown> {
  const prefix = boundLaneKey(project);
  const observed = async (record: BoundLaneRecord, known?: TrackerItem) => {
    const fresh = known ?? (await issue(record.cloudId));
    if (`work-${fresh.id.replace(/^.*-/, "")}` !== record.id)
      throw new ForgeFailure({
        code: "INPUT_CONFLICT",
        message: "Cloud issue does not match the device attachment.",
        retry: "never",
      });
    return fresh;
  };
  if (op === "lane.show") {
    // Resolve with authority before interpreting a display prefix as a stored identity.
    const fresh = await issue(input.id!);
    const id = `work-${fresh.id.replace(/^.*-/, "")}`;
    const found = state?.get(prefix + id);
    if (!found)
      throw new ForgeFailure({
        code: "NOT_FOUND",
        message: `No device lane for ${fresh.id}`,
        retry: "never",
      });
    const record = readBoundLane(found.value, id);
    const current = await observed(
      record,
      input.id === record.cloudId ? fresh : undefined,
    );
    return {
      ...record.lane,
      issue: current.id,
      ...(current.lease ? { lease: current.lease } : {}),
    };
  }
  const lanes = [];
  for (const found of state?.list(prefix) ?? []) {
    const record = readBoundLane(found.value, found.key.slice(prefix.length));
    const fresh = await observed(record);
    const current = fresh.lease;
    const held =
      current?.generation === record.grant.generation &&
      current.holder.actor.kind === record.grant.holder.actor.kind &&
      current.holder.actor.id === record.grant.holder.actor.id &&
      current.holder.session.id === record.grant.holder.session.id &&
      current.holder.session.device === record.grant.holder.session.device;
    lanes.push({
      id: fresh.id,
      step: record.active ? (held ? "attached" : "stale") : "inactive",
      stopped: false,
      calls: { used: 0, limit: 0 },
      activeHours: { used: 0, limit: 0 },
      rounds: { review: { used: 0, limit: 0 }, ci: { used: 0, limit: 0 } },
    });
  }
  return {
    enabled: false,
    stopped: false,
    stoppedLanes: [],
    hold: "Device-local attachments only; dispatch is not enabled.",
    lanes,
  };
}

function refuse(code: string, message: string): never {
  throw new ForgeFailure({ code, message, retry: "reconcile_first" });
}
const helpers = entry as unknown as {
  limitsOf(
    config: unknown,
  ): { enabled: boolean } & Record<
    "calls" | "reviewRounds" | "ciFixRounds" | "activeHours",
    number
  >;
  briefProblems(text: string): string[];
  briefPath(files: FilesService, path: string, windows: boolean): string;
  laneRegistry(
    files: FilesService,
    fail: typeof refuse,
  ): {
    text: string | null;
    lanes: (BoundLaneRecord["lane"] & { attempt?: string })[];
  };
};
export type BoundCommand = (
  op: string,
  input: object,
  generation?: number,
  release?: { requestId: string; holder: LeaseRecord["holder"] },
) => Promise<unknown>;

function ownBoundGrant(
  grant: LeaseRecord | undefined,
  context: AmbientContext,
  device: string,
  generation = context.leaseGeneration,
  now?: () => number,
): LeaseRecord {
  const holder = grant?.holder;
  if (
    !grant ||
    !holder ||
    holder.actor.kind !== context.actor?.kind ||
    holder.actor.id !== context.actor?.id ||
    holder.session.id !== context.session?.id ||
    holder.session.device !== device
  )
    refuse("LEASE_NOT_HELD", "This caller does not hold the cloud grant.");
  if (generation !== undefined && grant.generation !== generation)
    refuse("LEASE_STALE", "The cloud grant generation changed.");
  if (now && Date.parse(grant.expiresAt) <= now())
    refuse("LEASE_EXPIRED", "The cloud grant expired.");
  return grant;
}

export async function boundLaneStart(
  input: { id: string; branch: string; brief: string },
  context: AmbientContext,
  device: string,
  now: () => number,
  project: BoundProject,
  state: Pick<StateClient, "get"> | undefined,
  command: BoundCommand,
  save: (record: BoundLaneRecord, revision: number) => Promise<StateRecord>,
  attach: (
    record: BoundLaneRecord,
    fence: () => Promise<void>,
  ) => Promise<BoundLaneRecord["lane"]>,
): Promise<unknown> {
  const fresh = (await command("issue.show", { id: input.id })) as TrackerItem;
  const id = `work-${fresh.id.replace(/^.*-/, "")}`;
  const found = state?.get(boundLaneKey(project, id));
  const previous = found ? readBoundLane(found.value, id) : undefined;
  if (previous?.releaseRequestId)
    refuse("INPUT_CONFLICT", "Reconcile the pending release before attaching.");
  const own = (issue: TrackerItem, generation?: number) => {
    if (issue.status !== "open")
      refuse("INPUT_CONFLICT", "Closed issues cannot attach.");
    return ownBoundGrant(issue.lease, context, device, generation, now);
  };
  const grant = own(fresh, context.leaseGeneration);
  let progress = previous?.progress;
  if (progress && progress.generation !== grant.generation) {
    const { ask: _ask, verdict: _verdict, ...usage } = progress;
    progress = { ...usage, generation: grant.generation, pending: false };
  }
  let record: BoundLaneRecord = {
    version: 1,
    id,
    cloudId: fresh.id,
    grant,
    active: false,
    releaseNeeded: true,
    ...(progress ? { progress } : {}),
    lane: {
      issue: id,
      issueId: id,
      branch: input.branch,
      brief: input.brief,
      worktree: context.project!.root ?? context.project!.id,
    },
  };
  const revision = found?.revision ?? (await save(record, 0)).revision;
  const lane = await attach(record, async () => {
    own(
      (await command("issue.show", { id: record.cloudId })) as TrackerItem,
      grant.generation,
    );
  });
  record = { ...record, lane, active: true };
  await save(record, revision);
  return { ...lane, issue: fresh.id, lease: grant };
}

export type BoundProgressInput = {
  id: string;
  head?: string;
  action?: number;
  result?: string;
  mergeGate?: BoundProgress["verdict"];
};
export async function boundLaneProgress(
  op: string,
  input: BoundProgressInput,
  context: AmbientContext,
  device: string,
  now: () => number,
  project: BoundProject,
  state: Pick<StateClient, "get"> | undefined,
  command: BoundCommand,
  save: (record: BoundLaneRecord, revision: number) => Promise<StateRecord>,
  config: unknown,
): Promise<unknown> {
  const fresh = (await command("issue.show", { id: input.id })) as TrackerItem;
  const id = `work-${fresh.id.replace(/^.*-/, "")}`;
  const found = state?.get(boundLaneKey(project, id));
  if (!found) refuse("NOT_FOUND", `No device lane for ${fresh.id}`);
  const record = readBoundLane(found.value, id);
  if (
    op === "lane.record" &&
    context.leaseGeneration !== record.progress?.generation
  )
    refuse("INPUT_CONFLICT", "Record must match the reservation generation.");
  ownBoundGrant(record.grant, context, device);
  ownBoundGrant(fresh.lease, context, device, record.grant.generation, now);
  if (!record.active || record.releaseRequestId || fresh.status !== "open")
    refuse("INPUT_CONFLICT", "The lane is inactive, releasing or closed.");
  const p: BoundProgress = structuredClone(
    record.progress ?? {
      generation: record.grant.generation,
      actions: 0,
      records: 0,
      review: 0,
      ci: 0,
      started: now(),
      pending: false,
    },
  );
  const write = async () => {
    if (!validBoundProgress(p))
      refuse("INPUT_INVALID", "Invalid device progress result.");
    if (JSON.stringify(p) !== JSON.stringify(record.progress))
      await save({ ...record, progress: p }, found.revision);
  };
  if (op === "lane.record") {
    if (input.mergeGate) {
      if (input.mergeGate.head.toLowerCase() !== p.head)
        refuse("INPUT_CONFLICT", "Review must name the current reserved head.");
      p.verdict = { ...input.mergeGate, head: p.head };
    } else {
      if (!p.pending || input.action !== p.actions)
        refuse("INPUT_CONFLICT", "Only the pending action can be recorded.");
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.result!);
      } catch {
        return refuse("INPUT_INVALID", "Result must be a JSON object.");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        refuse("INPUT_INVALID", "Result must be a JSON object.");
      const result = parsed as Record<string, unknown>;
      if (result.head !== p.head)
        refuse("INPUT_CONFLICT", "Result must name the current reserved head.");
      if (result.ask !== undefined)
        p.ask = result.ask as NonNullable<BoundProgress["ask"]>;
      else if (result.answer !== undefined) {
        if (!p.ask) refuse("INPUT_CONFLICT", "There is no pending owner ask.");
        p.ask.answer = result.answer as string;
      } else {
        delete p.ask;
        p.pending = false;
        p.review += result.review === true ? 1 : 0;
        p.ci += result.ci === true ? 1 : 0;
      }
      p.records++;
    }
    await write();
    return {
      lane: fresh.id,
      step: input.mergeGate ? "merge" : "guard",
      n: p.actions,
      recorded: true,
    };
  }
  if (input.head && input.head.toLowerCase() !== p.head) {
    p.head = input.head.toLowerCase();
    delete p.verdict;
  }
  const limits = helpers.limitsOf(config);
  const exhausted =
    p.actions >= limits.calls ||
    p.review >= limits.reviewRounds ||
    p.ci >= limits.ciFixRounds;
  let kind = "harness",
    why = "Reserved local action; this is not dispatch permission.";
  if (p.ask) {
    kind = p.ask.answer ? "pause" : "ask-owner";
    why = JSON.stringify(p.ask);
  } else if (
    !limits.enabled ||
    now() - p.started >= limits.activeHours * 3_600_000 ||
    (!p.pending && exhausted)
  ) {
    kind = "pause";
    why = "Configured device budget or autopilot switch requires a pause.";
  } else if (!p.pending) {
    p.actions++;
    p.pending = true;
  }
  // A pure budget pause must not initialize or reset bookkeeping.
  if (kind !== "pause" || record.progress) await write();
  return {
    lane: fresh.id,
    step: "guard",
    n: p.actions,
    kind,
    why,
    expect:
      "Record the local action; bound runner dispatch remains unavailable until PR 2b.",
    budget: { actions: p.actions, records: p.records },
    raw: JSON.stringify({ generation: p.generation, head: p.head }),
    ...(p.ask && !p.ask.answer ? { ask: why } : {}),
  };
}

export async function boundLaneRelease(
  input: { id: string },
  context: AmbientContext,
  device: string,
  now: () => number,
  project: BoundProject,
  state: Pick<StateClient, "get"> | undefined,
  command: BoundCommand,
  save: (record: BoundLaneRecord, revision: number) => Promise<StateRecord>,
  requestId: string,
): Promise<unknown> {
  const fresh = (await command("issue.show", { id: input.id })) as TrackerItem;
  const id = `work-${fresh.id.replace(/^.*-/, "")}`;
  const found = state?.get(boundLaneKey(project, id));
  if (!found) refuse("NOT_FOUND", `No device lane for ${fresh.id}`);
  let record = readBoundLane(found.value, id),
    revision = found.revision;
  ownBoundGrant(record.grant, context, device);
  const current = (issue: TrackerItem) => {
    if (`work-${issue.id.replace(/^.*-/, "")}` !== record.id)
      refuse(
        "INPUT_CONFLICT",
        "Cloud issue does not match the device attachment.",
      );
    if (issue.lease)
      ownBoundGrant(issue.lease, context, device, record.grant.generation, now);
    return issue.lease;
  };
  if (current(fresh)) {
    const releaseRequestId = record.releaseRequestId ?? requestId;
    // The grant stays immutable while this request is pending; every retry uses its holder.
    if (!record.releaseRequestId) {
      record = { ...record, releaseNeeded: true, releaseRequestId };
      revision = (await save(record, revision)).revision;
    }
    try {
      const released = (await command(
        "issue.release",
        { id: record.cloudId },
        record.grant.generation,
        { requestId: releaseRequestId, holder: record.grant.holder },
      )) as { id: string };
      if (`work-${released.id.replace(/^.*-/, "")}` !== record.id)
        refuse(
          "INPUT_CONFLICT",
          "Cloud release does not match the device attachment.",
        );
    } catch (error) {
      if (
        !(error instanceof ForgeFailure) ||
        !["UNAVAILABLE", "LEASE_NOT_HELD"].includes(error.error.code)
      )
        throw error;
      // An uncertain write grants no local conclusion: read authority, never retry it blindly.
      if (
        current(
          (await command("issue.show", { id: record.cloudId })) as TrackerItem,
        )
      )
        throw error;
    }
  }
  const { releaseRequestId: _pending, ...released } = record;
  if (record.active || record.releaseNeeded !== false || _pending)
    await save({ ...released, active: false, releaseNeeded: false }, revision);
  return { issue: fresh.id, removed: false, keptBranch: record.lane.branch };
}

export function boundLaneGit(
  services: Pick<
    Parameters<typeof attachBoundLane>[1],
    "process" | "environment" | "signal" | "deadline"
  >,
  cwd: string,
): (args: string[]) => Promise<string> {
  const { process, environment, signal, deadline } = services;
  const env = environment.select([
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "windir",
    "HOME",
    "USERPROFILE",
    "TEMP",
    "TMP",
  ]);
  const git = resolveOutside(process, "git", env, cwd);
  if (git.kind !== "resolved") refuse("UNAVAILABLE", "Git is unavailable.");
  const readGit = async (args: string[]) => {
    const result = await process.run(git, args, {
      cwd: cwd,
      env,
      signal,
      timeoutMs: Math.max(1, deadline - Date.now()),
      maxOutputBytes: 16384,
    });
    if (result.exitCode !== 0 || result.timedOut || result.truncated)
      refuse("INPUT_CONFLICT", "Cannot read prepared checkout identity.");
    return result.stdout.trim();
  };
  return readGit;
}

export async function attachBoundLane(
  record: BoundLaneRecord,
  services: {
    files: FilesService;
    process: ProcessService;
    environment: EnvironmentService;
    signal: AbortSignal;
    deadline: number;
    now: () => number;
  },
  fence: () => Promise<void>,
): Promise<BoundLaneRecord["lane"]> {
  const { files, environment } = services;
  const path = (value: string) => {
    const slash = value.replace(/\\/g, "/").replace(/\/$/, "");
    return environment.platform === "win32" ? slash.toLowerCase() : slash;
  };
  const brief = helpers.briefPath(
    files,
    record.lane.brief,
    environment.platform === "win32",
  );
  const problems = helpers.briefProblems(files.read(brief, 262144) ?? "");
  if (problems.length) refuse("INPUT_INVALID", problems.join("; "));
  const readGit = boundLaneGit(services, files.root);
  const identity = async () => {
    if (
      path(await readGit(["rev-parse", "--show-toplevel"])) !==
        path(files.root) ||
      (await readGit(["symbolic-ref", "--quiet", "--short", "HEAD"])) !==
        record.lane.branch
    )
      refuse(
        "INPUT_CONFLICT",
        "Prepared checkout identity differs from the lane.",
      );
  };
  await identity();
  const lock = files.lock(["forge-lanes-registry.lock"], {
    recoverDeadOwner: true,
  });
  try {
    const saved = helpers.laneRegistry(files, refuse);
    const lane = {
      ...record.lane,
      worktree: files.root,
      brief: `${files.root.replace(/\\/g, "/")}/${brief}`,
    };
    const existing = saved.lanes.filter(
      (row) =>
        row.attempt === undefined &&
        (row.issueId ?? row.issue.replace(/^.*-/, "work-")) === record.id,
    );
    if (
      existing.length > 1 ||
      saved.lanes.some(
        (row) =>
          path(row.worktree) === path(lane.worktree) && !existing.includes(row),
      ) ||
      existing.some(
        (row) =>
          path(row.worktree) !== path(lane.worktree) ||
          row.branch !== lane.branch ||
          path(row.brief) !== path(lane.brief),
      )
    )
      refuse(
        "INPUT_CONFLICT",
        "Registry identity differs from the prepared attachment.",
      );
    await fence();
    await identity();
    if (Date.parse(record.grant.expiresAt) <= services.now())
      refuse("LEASE_EXPIRED", "The cloud grant expired.");
    if (!existing.length)
      files.write(
        "forge-lanes.json",
        JSON.stringify([...saved.lanes, lane]) + "\n",
        { area: "common", expected: saved.text },
      );
    return lane;
  } finally {
    lock.release();
  }
}
