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
import type { AssemblyProviders } from "./providers.ts";
import {
  boundLaneKey,
  validBoundHead,
  writeBoundLane,
} from "../blocks/work/bound-lane-state.ts";
import { nodeDeviceIdentity } from "../adapters/fs/device-identity.ts";
import { wireDeviceId } from "./wire-device.ts";
import { ForgeFailure } from "../contract/failure.ts";
const progressWrites = new Map<string, Promise<unknown>>();

function laneSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
}

/** A fresh, read-only lookup in the attachment, independent of the caller's checkout. */
export async function readBoundLaneHead(
  flight: Preflight,
  providers: AssemblyProviders,
  worktree: string,
  signal?: AbortSignal,
): Promise<string> {
  const timeoutMs = flight.operation.declaration.timeoutMs ?? 60000;
  const scope = {
    op: flight.request.op,
    effects: flight.operation.declaration.effects,
    signal: laneSignal(timeoutMs, signal),
    deadline: Date.now() + timeoutMs,
    processContainment: "supervised" as const,
  };
  const head = await boundLaneGit(
    {
      process: providers.process(scope),
      environment: providers.environment(scope),
      ...scope,
    },
    worktree,
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
    signal?: AbortSignal;
  },
): Promise<unknown> {
  const owner = await device.open(false);
  const { signal } = options;
  signal?.throwIfAborted();
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
    ) => {
      signal?.throwIfAborted();
      const store = (await device.open(true))!;
      signal?.throwIfAborted();
      const client = store.client("forge/work", flight.request.context.actor!);
      return writeBoundLane(client, project, record, revision);
    };
    if (["lane.next", "lane.record"].includes(flight.operation.declaredOp)) {
      // Serialize this device's reservations; StateOwner revisions fence other processes.
      const key = boundLaneKey(project);
      const pending = (progressWrites.get(key) ?? Promise.resolve())
        .catch(() => {})
        .then(() => {
          signal?.throwIfAborted();
          return boundLaneProgress(
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
            (worktree) =>
              readBoundLaneHead(flight, options.providers, worktree, signal),
          );
        });
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
        signal?.throwIfAborted();
        const client = (await device.open(true))!.client(
          "forge/work",
          flight.request.context.actor!,
        );
        return {
          save: (record, revision) => {
            signal?.throwIfAborted();
            return writeBoundLane(client, project, record, revision);
          },
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
        signal?.throwIfAborted();
        const timeoutMs = flight.operation.declaration.timeoutMs ?? 120000;
        const scope = {
          op: flight.request.op,
          effects: flight.operation.declaration.effects,
          signal: laneSignal(timeoutMs, signal),
          deadline: Date.now() + timeoutMs,
          processContainment: "supervised" as const,
        };
        const files = await options.providers.openFiles(scope);
        try {
          signal?.throwIfAborted();
          return await attachBoundLane(
            record,
            {
              files: files.value,
              process: options.providers.process(scope),
              environment: options.providers.environment(scope),
              now: options.now,
              ...scope,
            },
            fence,
            previous,
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
