import type { Preflight } from "../core/runtime/index.ts";
import type { TrackerItem } from "../generated/types.ts";
import {
  attachBoundLane,
  boundLaneRead,
  boundLaneStart,
  boundLaneRelease,
  boundLaneProgress,
  type BoundProgressInput,
  boundLaneGit,
  type BoundCommand,
} from "../blocks/work/bound-lane.ts";
import type { BoundProject } from "../blocks/work/bound-lane-state.ts";
import type { LocalState } from "./state.ts";
import {
  createGitScope,
  type GitScope,
  type AssemblyProviders,
} from "./providers.ts";
import {
  boundLaneKey,
  validBoundHead,
  writeBoundLane,
  readBoundLane,
} from "../blocks/work/bound-lane-state.ts";
import { nodeDeviceIdentity } from "../adapters/fs/device-identity.ts";
import { wireDeviceId } from "./wire-device.ts";
import { ForgeFailure } from "../contract/failure.ts";
const progressWrites = new Map<string, Promise<unknown>>();

/** A fresh, read-only lookup in the attachment, independent of the caller's checkout. */
export async function readBoundLaneHead(
  flight: Preflight,
  providers: AssemblyProviders,
  worktree: string,
  gitScope?: GitScope,
): Promise<string> {
  const timeoutMs = flight.operation.declaration.timeoutMs ?? 60000;
  const scope = {
    op: flight.request.op,
    effects: flight.operation.declaration.effects,
    signal: AbortSignal.timeout(timeoutMs),
    deadline: Date.now() + timeoutMs,
    processContainment: "supervised" as const,
  };
  const caller = await providers.startupGitScope?.();
  const head = await boundLaneGit(
    {
      process: providers.process(scope),
      environment: providers.environment(scope),
      ...scope,
    },
    worktree,
    gitScope ??
      (caller ? createGitScope(caller.project.lexical, worktree) : undefined),
    ...(caller === undefined ? [] : [caller]),
    ...(providers.gitScope === undefined ? [] : [providers.gitScope]),
  )(["rev-parse", "--verify", "HEAD"]);
  if (!validBoundHead(head))
    throw new ForgeFailure({
      code: "INPUT_CONFLICT",
      message: "Cannot read the attached checkout HEAD.",
      retry: "reconcile_first",
    });
  return head;
}

/** Device state is opened read-only, separately from the public operation's project context. */
export async function coordinateLane(
  flight: Preflight,
  project: BoundProject,
  device: LocalState,
  command: BoundCommand,
  options: {
    providers: AssemblyProviders;
    env: Readonly<Record<string, string | undefined>>;
    deviceRoot: string;
    now: () => number;
  },
): Promise<unknown> {
  const owner = await device.open(false);
  const state = owner && {
    get: (key: string) => owner.get("forge/work", key),
    list: (prefix?: string) => owner.list("forge/work", prefix),
  };
  if (
    ["lane.start", "lane.release", "lane.next", "lane.record"].includes(
      flight.operation.declaredOp,
    )
  ) {
    const local =
      options.env.FORGE_DEVICE_ID?.trim() ||
      nodeDeviceIdentity(options.deviceRoot).read();
    if (!local || !flight.request.context.session)
      throw new ForgeFailure({
        code: "CONTEXT_MISSING",
        message: "A bound lane needs this device and session.",
        retry: "never",
      });
    const save = async (
      record: import("../blocks/work/bound-lane-state.ts").BoundLaneRecord,
      revision: number,
    ) =>
      writeBoundLane(
        (await device.open(true))!.client(
          "forge/work",
          flight.request.context.actor!,
        ),
        project,
        record,
        revision,
      );
    if (["lane.next", "lane.record"].includes(flight.operation.declaredOp)) {
      // Serialize this device's reservations; StateOwner revisions fence other processes.
      const key = boundLaneKey(project);
      const pending = (progressWrites.get(key) ?? Promise.resolve())
        .catch(() => {})
        .then(() =>
          boundLaneProgress(
            flight.operation.declaredOp,
            flight.request.input as BoundProgressInput,
            flight.request.context,
            wireDeviceId(local),
            options.now,
            project,
            state,
            command,
            save,
            flight.config,
            (worktree, roots) =>
              readBoundLaneHead(flight, options.providers, worktree, roots),
          ),
        );
      progressWrites.set(key, pending);
      try {
        return await pending;
      } finally {
        if (progressWrites.get(key) === pending) progressWrites.delete(key);
      }
    }
    if (flight.operation.declaredOp === "lane.release")
      return boundLaneRelease(
        flight.request.input as { id: string },
        flight.request.context,
        wireDeviceId(local),
        options.now,
        project,
        state,
        command,
        save,
        flight.request.requestId,
      );
    return boundLaneStart(
      flight.request.input as { id: string; branch: string; brief: string },
      flight.request.context,
      wireDeviceId(local),
      options.now,
      project,
      state,
      command,
      async (id) => {
        const client = (await device.open(true))!.client(
          "forge/work",
          flight.request.context.actor!,
        );
        return {
          save: (record, revision) =>
            writeBoundLane(client, project, record, revision),
          restore(previous, revision) {
            if (previous) writeBoundLane(client, project, previous, revision);
            else
              client.delete(boundLaneKey(project, id), {
                expectRevision: revision,
              });
          },
        };
      },
      async (record, fence, previous) => {
        const scope = {
          op: flight.request.op,
          effects: flight.operation.declaration.effects,
          signal: AbortSignal.timeout(
            flight.operation.declaration.timeoutMs ?? 120000,
          ),
          deadline:
            Date.now() + (flight.operation.declaration.timeoutMs ?? 120000),
          processContainment: "supervised" as const,
        };
        const contextGitScope = await options.providers.startupGitScope?.();
        const files = await options.providers.openFiles(scope);
        try {
          return await attachBoundLane(
            record,
            {
              files: files.value,
              process: options.providers.process(scope),
              environment: options.providers.environment(scope),
              now: options.now,
              ...(options.providers.gitScope === undefined
                ? {}
                : { gitScope: options.providers.gitScope }),
              ...(contextGitScope === undefined ? {} : { contextGitScope }),
              ...scope,
            },
            fence,
            previous,
            async () => {
              const current = await device.open(false);
              const prefix = boundLaneKey(project);
              return (current?.list("forge/work", prefix) ?? []).map(
                (row) =>
                  readBoundLane(row.value, row.key.slice(prefix.length)).lane,
              );
            },
          );
        } finally {
          await files.close();
        }
      },
    );
  }
  return boundLaneRead(
    flight.operation.declaredOp,
    flight.request.input as { id?: string },
    project,
    state,
    async (id) => (await command("issue.show", { id })) as TrackerItem,
  );
}
