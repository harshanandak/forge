import type { Preflight } from "../core/runtime/index.ts";
import type { TrackerItem } from "../generated/types.ts";
import {
  attachBoundLane,
  boundLaneRead,
  boundLaneStart,
  type BoundCommand,
} from "../blocks/work/bound-lane.ts";
import type { BoundProject } from "../blocks/work/bound-lane-state.ts";
import type { LocalState } from "./state.ts";
import type { AssemblyProviders } from "./providers.ts";
import { writeBoundLane } from "../blocks/work/bound-lane-state.ts";
import { nodeDeviceIdentity } from "../adapters/fs/device-identity.ts";
import { wireDeviceId } from "./wire-device.ts";
import { ForgeFailure } from "../contract/failure.ts";

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
  if (flight.operation.declaredOp === "lane.start") {
    const local =
      options.env.FORGE_DEVICE_ID?.trim() ||
      nodeDeviceIdentity(options.deviceRoot).read();
    if (!local || !flight.request.context.session)
      throw new ForgeFailure({
        code: "CONTEXT_MISSING",
        message: "A bound lane needs this device and session.",
        retry: "never",
      });
    return boundLaneStart(
      flight.request.input as { id: string; branch: string; brief: string },
      flight.request.context,
      wireDeviceId(local),
      options.now,
      project,
      state,
      command,
      async (record, revision) =>
        writeBoundLane(
          (await device.open(true))!.client(
            "forge/work",
            flight.request.context.actor!,
          ),
          project,
          record,
          revision,
        ),
      async (record, fence) => {
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
        const files = await options.providers.openFiles(scope);
        try {
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
