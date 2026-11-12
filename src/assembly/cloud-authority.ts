// Forge cloud as the authority for a cloud-bound project's `issue show`, `issue comments`, `issue list`, `issue ready`, `issue create`,
// `issue comment`, `issue update`, `issue dep`, `issue close`, `issue claim`, `issue renew` and `issue release`: chosen after the Runtime's own request checks and before any local project state opens. A bound project
// writes only through the cloud, never to a local store, and no device is created.
import { nodeDeviceIdentity } from "../adapters/fs/device-identity.ts";
import { createCloudHttp } from "../adapters/http/index.ts";
import { ForgeFailure } from "../contract/failure.ts";
import { refuseDryRun, type Runtime } from "../core/runtime/index.ts";
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

/** The work operations a cloud-bound project serves from the cloud: the one list of them. */
const CLOUD_SERVED: ReadonlySet<string> = new Set([
  "issue.show",
  "issue.comments",
  "issue.list",
  "issue.ready",
  "issue.create",
  "issue.comment",
  "issue.update",
  "issue.dep",
  "issue.close",
  "issue.claim",
  "issue.renew",
  "issue.release",
]);

/** On a bound project: show, comments, list, ready, create, comment, update, dep, close, claim, renew and release go to the cloud, other work operations are refused (a second writer), other blocks stay local. */
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

/** The input the cloud cannot serve for an operation it routes yet, refused in one shape before any request. */
function unserved(declared: string, input: unknown): ForgeFailure | undefined {
  // Fail closed: an input that was not forwarded cannot be checked, so it is never taken as empty.
  if (input === undefined)
    return fail(
      "INPUT_INVALID",
      `${declared} was not given its input to check before a cloud request.`,
    );
  const { reopen, reason, receipt } = (input ?? {}) as Record<string, unknown>;
  const claim =
    declared === "issue.claim" &&
    (reopen !== undefined || reason !== undefined);
  const close = declared === "issue.close" && receipt !== undefined;
  return claim || close
    ? fail(
        "INPUT_INVALID",
        `${declared} with ${close ? "a receipt" : "reopen or reason"} is not supported in cloud yet.`,
      )
    : undefined;
}

/** Refuses an operation a bound project does not serve, a dry run of one it does, and input it cannot serve, before any lookup for it; an unbound project is never refused. */
export function admitCloud(
  deps: Pick<CloudAuthorityDeps, "root" | "env">,
  blockId: string,
  declared: string,
  dryRun: boolean | undefined,
  input: unknown,
): void {
  const route = cloudRoute(blockId, declared);
  const refusal =
    route === "cloud" && dryRun !== true
      ? unserved(declared, input)
      : undefined;
  if (route === "local" || (route === "cloud" && dryRun !== true && !refusal))
    return;
  if (
    cloudBinding(deps.root, deps.env.HOME ?? deps.env.USERPROFILE).kind !==
    "bound"
  )
    return;
  if (route instanceof ForgeFailure) throw route;
  if (refusal) throw refusal;
  refuseDryRun();
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
  const refusal = unserved(declared, request.input);
  if (refusal) throw refusal;
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
  const result = await client.command(
    {
      requestId: request.requestId,
      op: declared,
      input: request.input,
      context: {
        ...request.context,
        device: { id: device },
      },
    },
    (value) => block.validate(operation.declaration.output, value),
  );
  return { ok: true, op: request.op, status: "OK", result, warnings: [] };
}
