import { bindContext } from "../../src/contract/context.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { digestValue } from "../../src/core/config/pointer.ts";
import { validateBlockId } from "../../src/generated/validators.ts";
import type {
  StateCommitRequest,
  StateReadRequest,
} from "../../src/ports/state-protocol.ts";
import type { CommandHost } from "./issue-commands.ts";
import { PROJECT_NAME } from "./project-name.ts";
import { requireTokenSession } from "./token-session.ts";

const ROUTE = new RegExp(`^/p/(${PROJECT_NAME})/state/(read|commit)$`);
export const isStatePath = (request: Request): boolean =>
  /^\/p\/[^/]+\/state(?:\/|$)/.test(new URL(request.url).pathname);
export function stateRoute(request: Request) {
  const match = ROUTE.exec(new URL(request.url).pathname);
  return match === null ? undefined : { project: match[1]!, kind: match[2]! };
}
const fail = (code: string, message: string): never => {
  throw new ForgeFailure({ code, message, retry: "never" });
};

/** Config grants exact namespaces; it cannot grant the server's authority namespaces. */
export function admitState(
  input: StateReadRequest | StateCommitRequest,
  host: CommandHost,
  configured: unknown,
) {
  const { project, device, session } = input.context;
  if (
    (project?.id ?? host.project) !== host.project ||
    project?.root !== undefined
  )
    fail(
      "INPUT_INVALID",
      "context.project must be the admitted project, with no root",
    );
  if (
    (device?.id ?? host.device) !== host.device ||
    (session?.device ?? host.device) !== host.device
  )
    fail(
      "AUTH_DEVICE_MISMATCH",
      "The request names a device other than the token's",
    );
  requireTokenSession(host.session, session?.id);
  if (
    input.kind === "commit" &&
    input.fence !== undefined &&
    host.session == null
  )
    fail("AUTH_DEVICE_MISMATCH", "A state fence needs a token-bound session");
  const bound = bindContext(
    { context: "project" },
    {
      ...input.context,
      project: { id: host.project },
    },
  );
  if (!bound.ok) throw new ForgeFailure(bound.error);
  if (
    !Array.isArray(configured) ||
    !configured.every((id: unknown) => validateBlockId(id).ok)
  )
    fail(
      "UNAVAILABLE",
      "FORGE_STATE_NAMESPACES must be an explicit array of namespace IDs",
    );
  const namespaces = [...new Set(configured as string[])].sort();
  const namespace = input.namespace;
  if (
    namespace === "forge/work" ||
    namespace === "forge/cloud" ||
    namespace.startsWith("forge/core-") ||
    !namespaces.includes(namespace)
  )
    fail("AUTH_FORBIDDEN", "State namespace is not allowed");
  const policyRevision = digestValue(namespaces);
  if (
    input.policyRevision !== "discover" &&
    input.policyRevision !== policyRevision
  )
    fail("REVISION_CONFLICT", "State namespace configuration changed");
  return { context: bound.context, policyRevision };
}
