// Forge cloud as the authority for a cloud-bound project's `issue show`: chosen after the Runtime's own
// request checks and before any local project state opens. Nothing is written and no device is created.
import { nodeDeviceIdentity } from "../adapters/fs/device-identity.ts";
import { createCloudHttp } from "../adapters/http/index.ts";
import { ForgeFailure } from "../contract/failure.ts";
import type { Runtime } from "../core/runtime/index.ts";
import type { InvocationRequest, ResultEnvelope } from "../generated/types.ts";
import { cloudBinding } from "./cloud-binding.ts";
import type { CloudLoginDeps } from "./cloud-login.ts";
import { credentialStore, openCloudFiles } from "./cloud-profile.ts";
import { createCloudLeaseClient } from "./cloud-state-client.ts";

export interface CloudAuthorityDeps {
  readonly root: string;
  readonly deviceRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Network, clock and private-file seams, the same ones cloud login takes. */
  readonly cloud?:
    Partial<Pick<CloudLoginDeps, "fetch" | "now" | "security">> | undefined;
}
const fail = (code: string, message: string) =>
  new ForgeFailure({ code, message, retry: "never" });

/**
 * Where a resolved operation goes on a cloud-bound project: the cloud for `issue.show`, a refusal for every
 * other operation of the work block (they would write issue state locally, a second writer), and the local
 * runtime for the operations of other blocks.
 */
export function cloudRoute(
  blockId: string,
  declared: string,
): "local" | "cloud" | ForgeFailure {
  if (blockId !== "forge/work") return "local";
  return declared === "issue.show"
    ? "cloud"
    : fail(
        "INPUT_INVALID",
        `${declared} is not served by the cloud authority of a cloud-bound project yet.`,
      );
}

/** The cloud's envelope for a bound project's `issue show`; undefined when the local runtime should run. */
export async function selectCloud(
  deps: CloudAuthorityDeps,
  runtime: Pick<Runtime, "preflight">,
  request: InvocationRequest,
): Promise<ResultEnvelope | undefined> {
  let flight: ReturnType<Runtime["preflight"]>;
  try {
    flight = runtime.preflight(request);
  } catch {
    // The runtime refuses the same request in its own preflight, before it opens anything.
    return undefined;
  }
  const { block, operation } = flight;
  const declared = operation.declaredOp;
  const route = cloudRoute(block.manifest.id, declared);
  if (route === "local") return undefined;
  const home = deps.env.HOME ?? deps.env.USERPROFILE;
  const bound = cloudBinding(deps.root, home);
  if (bound.kind === "unbound") return undefined;
  if (route !== "cloud") throw route;
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
        device: request.context.device ?? { id: device },
      },
    },
    (value) => block.validate(operation.declaration.output, value),
  );
  return { ok: true, op: request.op, status: "OK", result, warnings: [] };
}
