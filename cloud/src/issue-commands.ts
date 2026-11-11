// POST /p/<project>/command: typed issue commands at the project authority.
// This slice checks the envelope and the context and then refuses every command as not yet
// supported: no operation runs and nothing is read or written. Everything the caller sends is
// untrusted. The envelope and context are closed shapes, the device comes from the token and the
// project from the server, and no caller value becomes an SQL identifier, a namespace or a key.
import manifest from "../../src/blocks/work/forge.block.json" with { type: "json" };
import { bindContext } from "../../src/contract/context.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { parseUntrustedJson } from "../../src/contract/untrusted.ts";
import type {
  BoundContext,
  ForgeError,
  OperationDeclaration,
  ResultEnvelope,
} from "../../src/generated/types.ts";
import {
  validateAmbientContext,
  validateOperationName,
  validateRequestId,
} from "../../src/generated/validators.ts";

export const MAX_COMMAND_BODY = 512 * 1024;
const COMMAND_ROUTE = /^\/p\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/command$/;
const FIELDS = ["requestId", "op", "input", "context", "dryRun"];
const LIMITS = {
  maxBytes: MAX_COMMAND_BODY,
  maxDepth: 32,
  maxNodes: 5000,
  maxStringLength: MAX_COMMAND_BODY,
};
// The cloud's exposure policy: names only. What each one needs comes from the work block's own
// declaration, so there is no second catalog.
const EXPOSED: readonly string[] = [
  "issue.create",
  "issue.update",
  "issue.comment",
  "issue.show",
  "issue.comments",
  "issue.list",
  "issue.ready",
];
const operations = manifest.operations as unknown as Readonly<
  Record<string, OperationDeclaration>
>;

/** The project a command route names, or undefined when the path is not the command route. */
export const commandProject = (request: Request): string | undefined =>
  COMMAND_ROUTE.exec(new URL(request.url).pathname)?.[1];

export const failed = (error: ForgeError): ResultEnvelope => ({
  ok: false,
  status: "FAIL",
  error,
  warnings: [],
});

const fail = (code: string, message: string): ForgeFailure =>
  new ForgeFailure({ code, message, retry: "never" });

export interface CommandHost {
  /** The device the token names: the only identity the server trusts. */
  readonly device: string;
  /** The admitted project, fixed by the server. */
  readonly project: string;
}
export interface PreparedCommand {
  readonly op: string;
  readonly input: unknown;
  readonly context: BoundContext;
}

/**
 * Checks one command text and binds the context its operation declares. Throws ForgeFailure when
 * refused. Messages are fixed text or name a limit: they never repeat what the caller sent.
 */
export function prepareCommand(
  text: string,
  host: CommandHost,
): PreparedCommand {
  const parsed = parseUntrustedJson(text, LIMITS);
  if (!parsed.ok)
    throw fail(
      "INPUT_INVALID",
      parsed.error.code === "LIMIT_EXCEEDED"
        ? parsed.error.message
        : "body must be JSON",
    );
  const call = parsed.value as Record<string, unknown>;
  const closed =
    typeof call === "object" &&
    call !== null &&
    !Array.isArray(call) &&
    Object.keys(call).every((key) => FIELDS.includes(key)) &&
    "input" in call &&
    validateRequestId(call.requestId).ok &&
    validateOperationName(call.op).ok &&
    (call.dryRun === undefined || typeof call.dryRun === "boolean");
  const checked = closed ? validateAmbientContext(call.context) : undefined;
  if (!closed || !checked?.ok)
    throw fail(
      "INPUT_INVALID",
      "body must be { requestId, op, input, context, dryRun? } with a valid context",
    );
  const op = call.op as string;
  if (!EXPOSED.includes(op) || !Object.hasOwn(operations, op))
    throw fail("UNKNOWN_COMMAND", "No such command");
  const { session, device, project, ...rest } = checked.value;
  // The token proves the device; a named one must match it. Neither value is repeated.
  if (
    (session?.device ?? host.device) !== host.device ||
    (device?.id ?? host.device) !== host.device
  )
    throw fail(
      "AUTH_DEVICE_MISMATCH",
      "The request names a device other than the token's",
    );
  if (
    (project?.id ?? host.project) !== host.project ||
    project?.root !== undefined
  )
    throw fail(
      "INPUT_INVALID",
      "context.project must be the admitted project, with no root",
    );
  if (call.dryRun === true)
    throw fail("UNAVAILABLE", "this profile has no dry-run execution contract");
  const bound = bindContext(operations[op]!, {
    ...rest,
    project: { id: host.project },
    ...(session === undefined
      ? {}
      : { session: { ...session, device: host.device } }),
  });
  if (!bound.ok) throw new ForgeFailure(bound.error);
  return { op, input: call.input, context: bound.context };
}

/** Prepares a command and refuses it: the operations arrive in later slices. Always throws. */
export function runCommand(text: string, host: CommandHost): never {
  prepareCommand(text, host);
  throw fail("INPUT_INVALID", "Commands are not yet supported in cloud");
}
