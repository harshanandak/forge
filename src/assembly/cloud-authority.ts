// Forge cloud as the authority for a cloud-bound project's `issue show`, `issue list`, `issue ready`, `issue create`,
// `issue comment`, `issue update`, `issue claim`, `issue renew` and `issue release`: chosen after the Runtime's own request checks and before any local project state opens. A bound project
// writes only through the cloud, never to a local store, and no device is created.
import { randomUUID } from "node:crypto";
import { nodeDeviceIdentity } from "../adapters/fs/device-identity.ts";
import { createCloudHttp } from "../adapters/http/index.ts";
import { ForgeFailure } from "../contract/failure.ts";
import type { Runtime } from "../core/runtime/index.ts";
import type { BoundContext } from "../generated/types.ts";
import type { InvocationRequest, ResultEnvelope } from "../generated/types.ts";
import { cloudBinding } from "./cloud-binding.ts";
import { wireDeviceId, type CloudLoginDeps } from "./cloud-login.ts";
import { credentialStore, openCloudFiles } from "./cloud-profile.ts";
import { createCloudLeaseClient } from "./cloud-state-client.ts";

export interface CloudAuthorityDeps {
  readonly root: string;
  readonly deviceRoot: string;
  /** The runtime's own check that a context is this project's; it throws the refusal. */
  readonly scope: (context: BoundContext) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Network, clock and private-file seams, the same ones cloud login takes. */
  readonly cloud?:
    Partial<Pick<CloudLoginDeps, "fetch" | "now" | "security">> | undefined;
}
const fail = (code: string, message: string) =>
  new ForgeFailure({ code, message, retry: "never" });

/** The work operations a cloud-bound project serves from the cloud, and how: the one list of them. */
const CLOUD_SERVED: ReadonlyMap<string, "command" | "renew" | "release"> =
  new Map([
    ["issue.show", "command"],
    ["issue.list", "command"],
    ["issue.ready", "command"],
    ["issue.create", "command"],
    ["issue.comment", "command"],
    ["issue.update", "command"],
    ["issue.claim", "command"],
    ["issue.renew", "renew"],
    ["issue.release", "release"],
  ]);
const UNAVAILABLE = "The Forge cloud gave no usable answer.";

/** On a bound project: show, list, ready, create, comment, update, claim, renew and release go to the cloud, other work operations are refused (a second writer), other blocks stay local. */
export function cloudRoute(
  blockId: string,
  declared: string,
): "local" | "cloud" | ForgeFailure {
  if (blockId !== "forge/work") return "local";
  return CLOUD_SERVED.has(declared)
    ? "cloud"
    : fail(
        "INPUT_INVALID",
        `${declared} is not served by the cloud authority of a cloud-bound project yet.`,
      );
}

/** The cloud's envelope for a bound project's served operation; undefined when the local runtime should run. */
export async function selectCloud(
  deps: CloudAuthorityDeps,
  runtime: Pick<Runtime, "preflight">,
  request: InvocationRequest,
): Promise<ResultEnvelope | undefined> {
  const home = deps.env.HOME ?? deps.env.USERPROFILE;
  const binding = () => cloudBinding(deps.root, home);
  let flight: ReturnType<Runtime["preflight"]>;
  try {
    flight = runtime.preflight(request);
  } catch (refused) {
    // An unbound project lets the runtime refuse it. A bound one never reaches the local runtime, even
    // if a later preflight there would pass.
    if (binding().kind === "unbound") return undefined;
    throw refused;
  }
  const { block, operation } = flight;
  const declared = operation.declaredOp;
  const route = cloudRoute(block.manifest.id, declared);
  if (route === "local") return undefined;
  const bound = binding();
  if (bound.kind === "unbound") return undefined;
  deps.scope(flight.context);
  if (route !== "cloud") throw route;
  // A routed write must never become a real cloud write by a dry run, whatever the runtime's own checks did.
  if (request.dryRun === true)
    throw fail(
      "UNAVAILABLE",
      "This profile has no dry-run execution contract.",
    );
  const input = request.input as { reopen?: unknown; reason?: unknown };
  if (
    declared === "issue.claim" &&
    (input.reopen !== undefined || input.reason !== undefined)
  )
    throw fail(
      "INPUT_INVALID",
      "issue.claim with reopen or reason is not supported in cloud yet.",
    );
  let device: string | undefined;
  try {
    device =
      deps.env.FORGE_DEVICE_ID?.trim() ||
      nodeDeviceIdentity(deps.deviceRoot).read();
  } catch {
    device = undefined;
  }
  if (device === undefined)
    throw fail(
      "CONTEXT_MISSING",
      "A cloud-bound project needs this machine's device identity; run forge cloud login or set FORGE_DEVICE_ID.",
    );
  const { origin, project, identity } = bound;
  const named = request.context.device?.id;
  // A supplied device must be this machine: its device root, or an id in the same wire form.
  if (
    named !== undefined &&
    named !== deps.deviceRoot &&
    wireDeviceId(named) !== wireDeviceId(device)
  )
    throw fail("AUTH_DEVICE_MISMATCH", "This session is not on this machine.");
  const { fetch, now, security } = deps.cloud ?? {};
  const client = createCloudLeaseClient({
    key: { origin, identity, project },
    credentials: credentialStore(openCloudFiles(home, security, {})),
    now: now ?? Date.now,
    http: createCloudHttp({ origin, project, ...(fetch ? { fetch } : {}) }),
  });
  const context = { ...request.context, device: { id: device } };
  const lane = CLOUD_SERVED.get(declared);
  if (lane !== "renew" && lane !== "release") {
    const result = await client.command(
      {
        requestId: request.requestId,
        op: declared,
        input: request.input,
        context,
      },
      (value) => block.validate(operation.declaration.output, value),
    );
    return { ok: true, op: request.op, status: "OK", result, warnings: [] };
  }
  // Renew and release act on the lease the cloud reports: its stored subject comes from a validated show,
  // its generation from the context. Nothing is derived, made up or refreshed here.
  const { id, ttlSeconds } = request.input as {
    id: string;
    ttlSeconds?: number;
  };
  const shown = await client.command(
    { requestId: randomUUID(), op: "issue.show", input: { id }, context },
    (value) =>
      block.validate(block.manifest.operations["issue.show"]!.output, value),
  );
  const subject = (shown.lease as { subject?: string } | undefined)?.subject;
  const { actor, session, leaseGeneration: generation } = request.context;
  if (subject === undefined)
    throw fail("LEASE_NOT_HELD", "The issue has no live lease in the cloud.");
  if (actor === undefined || session === undefined || generation === undefined)
    throw fail(
      "CONTEXT_MISSING",
      "A lease needs an actor, a session and a generation.",
    );
  const call = {
    subject,
    holder: { actor, session: { ...session, device } },
    requestId: request.requestId,
    generation,
  };
  const held =
    lane === "renew"
      ? await client.renew({ ...call, ttlMs: (ttlSeconds ?? 3600) * 1000 })
      : await client.release(call);
  const result =
    lane === "renew"
      ? { id: shown.id, generation: held.generation, expiresAt: held.expiresAt }
      : { id: shown.id };
  if (!block.validate(operation.declaration.output, result))
    throw fail("UNAVAILABLE", UNAVAILABLE);
  return { ok: true, op: request.op, status: "OK", result, warnings: [] };
}
