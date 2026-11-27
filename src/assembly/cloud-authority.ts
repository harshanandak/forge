// Cloud-served work operations run after request checks and before local state or approval handling.
// A bound project writes only through the cloud; no local store or device is created.
import { nodeDeviceIdentity } from "../adapters/fs/device-identity.ts";
import { ForgeFailure } from "../contract/failure.ts";
import { BOUND_LANES } from "../blocks/work/bound-lane-ops.ts";
import type { BoundProject } from "../blocks/work/bound-lane-state.ts";
import {
  failureEnvelope,
  refuseDryRun,
  type Runtime,
  type Preflight,
} from "../core/runtime/index.ts";
import type { BoundContext } from "../generated/types.ts";
import type { InvocationRequest, ResultEnvelope } from "../generated/types.ts";
import { cloudBinding } from "./cloud-binding.ts";
import type { CloudLoginDeps } from "./cloud-login.ts";
import { credentialStore, openCloudFiles } from "./cloud-profile.ts";
import { lazy } from "./lazy.ts";
import { wireDeviceId } from "./wire-device.ts";

// Only a routed call to a cloud-bound project reaches the network, so a local call never loads these.
const loadHttp = lazy(() => import("../adapters/http/index.ts"));
const loadLeaseClient = lazy(() => import("./cloud-state-client.ts"));

export interface CloudAuthorityDeps {
  readonly coordinate?: (
    flight: Preflight,
    project: BoundProject,
  ) => Promise<unknown>;
  readonly root: string;
  readonly deviceRoot: string;
  readonly signal?: AbortSignal;
  /** The runtime's own check that a context is this project's; it throws the refusal. */
  readonly scope: (context: BoundContext) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Network, clock and private-file seams, the same ones cloud login takes. */
  readonly cloud?:
    Partial<Pick<CloudLoginDeps, "fetch" | "now" | "security">> | undefined;
}
const fail = (code: string, message: string) =>
  new ForgeFailure({ code, message, retry: "never" });
const notServed = (declared: string) =>
  fail(
    "INPUT_INVALID",
    `${declared} is not served by the cloud authority of a cloud-bound project yet.`,
  );

/** Recheck authority for every writable owner, including an already cached owner. */
export function refuseUnsupportedProjectWrite(
  root: string,
  home: string | undefined,
): void {
  if (cloudBinding(root, home).kind === "bound")
    throw new ForgeFailure({
      code: "UNAVAILABLE",
      message:
        "This project is connected to Forge cloud. Local project-state writes are unavailable because this block has no cloud version.",
      retry: "never",
      repair:
        "Use cloud-served forge issue commands for issue work. For device-only notes, use memory.add with level=device; block authors must declare context=device and use device state. Other project-state writes must wait until their blocks have cloud versions (forge-1345). Do not run forge store reinit or remove the cloud binding to bypass this refusal.",
    });
}

/** Selected lazily, only after device registration proves a store was lost. */
export function boundMissingStoreRemedy(
  root: string,
  home: string | undefined,
  path: string,
): string | undefined {
  return cloudBinding(root, home).kind === "bound"
    ? `Missing local Forge store at ${path}. This project is cloud-bound; forge store reinit is disabled. Use cloud-served forge issue commands for shared issue state. To inspect historical local-only records, restore a backup; unsupported project-state writes remain disabled.`
    : undefined;
}

/** The work operations a cloud-bound project serves from the cloud: the one list of them. */
const CLOUD_SERVED: ReadonlySet<string> = new Set([
  "issue.show",
  "issue.comments",
  "issue.links",
  "issue.list",
  "issue.ready",
  "issue.blocked",
  "issue.stale",
  "issue.create",
  "issue.comment",
  "issue.update",
  "issue.dep",
  "issue.link",
  "issue.close",
  "issue.claim",
  "issue.renew",
  "issue.release",
  "lane.stop",
  "lane.control",
  "lane.resume",
  "lane.dispatch",
]);

const isDispatch = (blockId: string | undefined, op: string | undefined) =>
  blockId === "forge/work" && op === "lane.dispatch";
const noDispatchBinding = () =>
  fail("UNAVAILABLE", "Lane dispatch requires a cloud-bound project");

/** Bound work uses CLOUD_SERVED; other work and store recovery refuse a second writer. Other blocks stay local. */
export function cloudRoute(
  blockId: string,
  declared: string,
): "local" | "cloud" | "coordinator" | ForgeFailure {
  if (blockId === "forge/core")
    return declared === "store.reinit" ? notServed(declared) : "local";
  if (blockId !== "forge/work") return "local";
  if (BOUND_LANES.has(declared)) return "coordinator";
  return CLOUD_SERVED.has(declared) ? "cloud" : notServed(declared);
}

/** The input the cloud cannot serve for an operation it routes yet, refused in one shape before any request. */
function unserved(declared: string, input: unknown): ForgeFailure | undefined {
  if (
    BOUND_LANES.has(declared) &&
    (![
      "lane.show",
      "lane.status",
      "lane.start",
      "lane.release",
      "lane.next",
      "lane.record",
    ].includes(declared) ||
      (declared === "lane.next" && !(input as { head?: string })?.head) ||
      (declared === "lane.record" && !(input as { id?: string })?.id) ||
      (typeof input === "object" && input !== null && "attempt" in input))
  )
    return notServed(declared);
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

/** PR proof belongs to the cloud verifier; reject local or mixed proof before lease lookup. */
function admitPrClose(
  deps: Pick<CloudAuthorityDeps, "root" | "env">,
  declared: string | undefined,
  input: unknown,
): void {
  if (
    declared !== "issue.close" ||
    typeof input !== "object" ||
    input === null ||
    !("pr" in input)
  )
    return;
  const binding = cloudBinding(
    deps.root,
    deps.env.HOME ?? deps.env.USERPROFILE,
  );
  if (
    ("receipt" in input && input.receipt !== undefined) ||
    ("withoutReceipt" in input && input.withoutReceipt !== undefined)
  )
    throw fail(
      "INPUT_INVALID",
      "pr cannot be combined with receipt or withoutReceipt.",
    );
  if (binding.kind === "unbound")
    throw fail(
      "INPUT_INVALID",
      "Closing with pr requires a cloud-bound project and its GitHub verifier.",
    );
}

/** Bound requests refuse unsupported operations, input and dry runs except stop; unbound requests stay local. */
export function admitCloud(
  deps: Pick<CloudAuthorityDeps, "root" | "env">,
  blockId: string,
  declared: string,
  dryRun: boolean | undefined,
  input: unknown,
): void {
  if (blockId === "forge/work") admitPrClose(deps, declared, input);
  if (
    isDispatch(blockId, declared) &&
    cloudBinding(deps.root, deps.env.HOME ?? deps.env.USERPROFILE).kind ===
      "unbound"
  )
    throw noDispatchBinding();
  const route = cloudRoute(blockId, declared);
  const dryRefused = dryRun === true && declared !== "lane.stop";
  const remote = route === "cloud" || route === "coordinator";
  const refusal = remote && !dryRefused ? unserved(declared, input) : undefined;
  if (route === "local" || (remote && !dryRefused && !refusal)) return;
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
  declaredOp?: string,
  blockId?: string,
): Promise<ResultEnvelope | undefined> {
  if (blockId === "forge/work") admitPrClose(deps, declaredOp, request.input);
  const home = deps.env.HOME ?? deps.env.USERPROFILE;
  const binding = () => cloudBinding(deps.root, home);
  if (isDispatch(blockId, declaredOp) && binding().kind === "unbound")
    throw noDispatchBinding();
  let flight: ReturnType<Runtime["preflight"]>;
  let accepted: InvocationRequest | undefined;
  try {
    // Stop has a cloud dry-run contract; the local runtime has none. All other checks still run.
    const dryStop =
      request.dryRun === true &&
      declaredOp === "lane.stop" &&
      binding().kind === "bound";
    flight = runtime.preflight(
      dryStop ? { ...request, dryRun: false } : request,
      (valid) => (accepted = valid),
    );
  } catch (refused) {
    // An unbound project lets the runtime refuse it. A bound one never reaches the local runtime, even
    // if a later preflight there would pass, so it gets the envelope the runtime gives that refusal.
    if (binding().kind === "unbound") return undefined;
    return failureEnvelope(accepted, refused);
  }
  const { block, operation } = flight;
  const declared = operation.declaredOp;
  const route = cloudRoute(block.manifest.id, declared);
  if (route === "local") return undefined;
  const bound = binding();
  if (bound.kind === "unbound") return undefined;
  deps.scope(flight.context);
  if (route === "coordinator") {
    if (!block.shipped) throw notServed(declared);
    const refusal = unserved(declared, request.input);
    if (refusal) throw refusal;
    if (!deps.coordinate)
      throw fail("UNAVAILABLE", "Device lane coordinator is not assembled.");
    const result = await deps.coordinate(flight, bound);
    if (!block.validate(operation.declaration.output, result))
      throw fail("OUTPUT_INVALID", "Invalid lane coordinator result.");
    return { ok: true, op: request.op, status: "OK", result, warnings: [] };
  }
  if (route !== "cloud") throw route;
  // Only stop may forward a dry run, and its original flag must reach the cloud.
  if (request.dryRun === true && declared !== "lane.stop")
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
      "A cloud-bound project needs this machine's device identity; run forge auth login or set FORGE_DEVICE_ID.",
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
  const [{ createCloudHttp }, { createCloudLeaseClient, CloudCommandFailure }] =
    await Promise.all([loadHttp(), loadLeaseClient()]);
  deps.signal?.throwIfAborted();
  const { fetch, now, security } = deps.cloud ?? {};
  const client = createCloudLeaseClient({
    key: { origin, identity, project },
    credentials: credentialStore(openCloudFiles(home, security, {})),
    now: now ?? Date.now,
    http: createCloudHttp({ origin, project, ...(fetch ? { fetch } : {}) }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  try {
    const { leaseGeneration: _generation, ...withoutGeneration } =
      request.context;
    const result = await client.command(
      {
        requestId: request.requestId,
        op: declared,
        input: request.input,
        ...(request.dryRun === true ? { dryRun: true } : {}),
        context: {
          ...(isDispatch(blockId, declared)
            ? withoutGeneration
            : request.context),
          device: { id: device },
        },
      },
      (value) => block.validate(operation.declaration.output, value),
    );
    return { ok: true, op: request.op, status: "OK", result, warnings: [] };
  } catch (error) {
    if (!(error instanceof CloudCommandFailure)) throw error;
    return { ...failureEnvelope(request, error), result: error.result };
  }
}
