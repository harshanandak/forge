import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createAssembly, localCall } from "../src/assembly/index.ts";
import { cloudBinding } from "../src/assembly/cloud-binding.ts";
import * as bound from "../src/blocks/work/bound-lane.ts";
import { ForgeFailure } from "../src/contract/failure.ts";
import { validateWithSchema } from "../src/contract/schema.ts";
import { dispatch } from "../src/surface/dispatch.ts";
import { createAssemblyProviders } from "../src/assembly/providers.ts";
import schema from "../src/blocks/work/schemas/lane-control.output.json" with { type: "json" };

export async function readLaneControl(command: bound.BoundCommand, id: string) {
  try {
    if (!/^work-[1-9]\d*$/.test(id)) return "unknown";
    const result = await command("lane.control", { id });
    if (validateWithSchema(schema, result).length) return "unknown";
    return (result as { stopped: boolean }).stopped ? "stopped" : "running";
  } catch {
    return "unknown";
  }
}
const clock = {
  now: Date.now,
  schedule: (run: () => Promise<void>, ms: number) => {
    const timer = setTimeout(() => {
      void run();
    }, ms);
    return () => clearTimeout(timer);
  },
};
export function boundDispatch(
  command: bound.BoundCommand,
  id: string,
  generation: number,
  timing = clock,
) {
  let pending: Promise<void> | undefined,
    failure: Error | undefined,
    closed = false,
    expiry = 0;
  let cancel = () => {};
  const renew = (): Promise<void> => {
    if (pending) return pending;
    if (failure || closed) return Promise.resolve();
    cancel();
    pending = (async () => {
      try {
        const grant = (await command("issue.renew", { id }, generation)) as {
          generation: number;
          expiresAt: string;
        };
        expiry = Date.parse(grant.expiresAt);
        const remaining = expiry - timing.now();
        if (grant.generation !== generation || !(remaining > 0))
          throw new Error("Renewal lost the grant.");
        if (!closed)
          cancel = timing.schedule(renew, Math.max(1, remaining / 3));
      } catch (error) {
        failure =
          error instanceof Error
            ? error
            : new Error("Renewal outcome unknown.", { cause: error });
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };
  const requireGrant = () => {
    if (failure) throw failure;
    if (closed || expiry <= timing.now())
      throw new Error("Dispatch grant is no longer valid.");
  };
  return {
    async beforeSpawn(this: void) {
      await renew();
      requireGrant();
      // The only control read: after preparation/renewal, immediately before each spawn.
      const control = await readLaneControl(command, id);
      requireGrant();
      if (control !== "running")
        throw new Error(`Bound lane dispatch refused: control ${control}.`);
    },
    async close() {
      closed = true;
      cancel();
      await pending;
    },
  };
}

async function connectRunner(root: string) {
  if (
    cloudBinding(root, process.env.HOME ?? process.env.USERPROFILE).kind !==
    "bound"
  )
    return undefined;
  const assembly = await createAssembly({
    root,
    deviceRoot: process.env.FORGE_DEVICE_ROOT ?? join(homedir(), ".forge"),
  });
  const options = localCall(assembly);
  const command: bound.BoundCommand = async (op, input, generation) => {
    const result = await dispatch(assembly.catalog, op, input, {
      ...options,
      ...(generation === undefined
        ? {}
        : { context: { ...options.context, leaseGeneration: generation } }),
    });
    if (!result.ok) throw new ForgeFailure(result.error);
    return result.result;
  };
  return {
    command,
    readHead: () => {
      const scope = {
        op: "lane.record",
        effects: ["environment:read", "external:process"],
        signal: AbortSignal.timeout(60000),
        deadline: Date.now() + 60000,
        processContainment: "supervised" as const,
      };
      const providers = createAssemblyProviders(root);
      return bound.boundLaneGit(
        {
          ...scope,
          process: providers.process(scope),
          environment: providers.environment(scope),
        },
        root,
      )(["rev-parse", "--verify", "HEAD"]);
    },
    close: () => assembly.close(),
  };
}
export async function openBoundRunner(
  root: string,
  id: string,
  head: string,
  connect = connectRunner,
  timing = clock,
) {
  const connection = await connect(root);
  if (!connection) return undefined;
  const { command } = connection;
  try {
    const lane = (await command("lane.show", { id })) as { worktree: string };
    if (resolve(lane.worktree) !== resolve(root))
      throw new Error("The attached checkout differs from the run target.");
    const next = (await command("lane.next", { id, head })) as {
      lane: string;
      kind: string;
      n: number;
      raw: string;
      why: string;
    };
    if (next.kind !== "harness")
      throw new Error(`Bound lane dispatch paused: ${next.why}`);
    const { generation, head: reserved } = JSON.parse(next.raw) as {
      generation: number;
      head: string;
    };
    if (
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      reserved !== head
    )
      throw new Error("Invalid dispatch reservation.");
    const canonical = `work-${next.lane.replace(/^.*-/, "")}`;
    const boundary = boundDispatch(command, canonical, generation, timing);
    return {
      beforeSpawn: boundary.beforeSpawn,
      async finish(spawned: boolean, success = false, role?: string) {
        await boundary.close();
        try {
          if (spawned) {
            const actual = await connection.readHead();
            if (actual !== head) {
              const rebound = (await command(
                "lane.next",
                { id, head: actual },
                generation,
              )) as { n: number };
              if (rebound.n !== next.n)
                throw new Error("The pending dispatch action changed.");
            }
            await command(
              "lane.record",
              {
                id,
                action: next.n,
                result: JSON.stringify({
                  head: actual,
                  ...(success ? { done: true } : { failed: true }),
                  ...(role === "reviewer" ? { review: true } : {}),
                }),
              },
              generation,
            );
          }
        } finally {
          await connection.close();
        }
      },
    };
  } catch (error) {
    await connection.close();
    throw new Error(
      `Bound lane dispatch refused: ${error instanceof Error ? error.message : "unknown coordinator result"}`,
      { cause: error },
    );
  }
}
