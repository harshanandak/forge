// POST /p/<project>/command: typed project commands admitted by the exposure policy below.
// The envelope and context are closed shapes, the device comes from the token and the
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

import {
  LEASE_READS,
  MAX_SHOW_RESPONSE_BYTES,
  readIssue,
  RECORD_READS,
  type IssueViews,
} from "./issue-read.ts";
import { claimIssue } from "./issue-claim.ts";
import { commentIssue } from "./issue-comment.ts";
import { createIssue } from "./issue-create.ts";
import { closeIssue } from "./issue-close.ts";
import { depIssue } from "./issue-dep.ts";
import { linkIssue } from "./issue-link.ts";
import { releaseIssue, renewIssue } from "./issue-lease.ts";
import { listComments } from "./issue-comments.ts";
import { listLinks } from "./issue-links.ts";
import { listIssues } from "./issue-list.ts";
import { updateIssue } from "./issue-update.ts";
import { laneCommand } from "./lane-commands.ts";
import { PROJECT_NAME } from "./project-name.ts";
import { requireTokenSession } from "./token-session.ts";
import { carriesToken } from "./tokens.ts";
import { failure } from "../../src/surface/result.ts";
import {
  guardLegacy,
  scopeRequestId,
  type ReceiptPrincipal,
} from "./issue-request-id.ts";
import { readOnlyStore, type DurableStorage } from "./store.ts";
import type { StateOwner } from "../../src/core/state/index.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";

export const MAX_COMMAND_BODY = 512 * 1024;
const COMMAND_ROUTE = new RegExp(`^/p/(${PROJECT_NAME})/command$`);
const FIELDS = ["requestId", "op", "input", "context", "dryRun"];
export const LIMITS = {
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
  "issue.dep",
  "issue.link",
  "issue.close",
  "issue.claim",
  "issue.renew",
  "issue.release",
  "issue.comment",
  "issue.show",
  "issue.comments",
  "issue.links",
  "issue.list",
  "issue.ready",
  "issue.blocked",
  "issue.stale",
  "lane.control",
  "lane.stop",
  "lane.resume",
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
  /** The session the token is bound to; none for a token of the device alone. */
  readonly session?: string | null;
}
export interface PreparedCommand {
  readonly requestId: string;
  readonly op: string;
  readonly input: unknown;
  readonly context: BoundContext;
  readonly dryRun?: true;
}

/**
 * Checks one command text and binds the context its operation declares. Throws ForgeFailure when
 * refused. Messages are fixed text or name a limit: they never repeat what the caller sent.
 */
export function parseCommand(text: string, host: CommandHost): PreparedCommand {
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
  // A token bound to a session proves it too, so a lease holder's session is never the caller's claim.
  requireTokenSession(host.session, session?.id);
  if (
    (op === "lane.control" || op === "lane.stop" || op === "lane.resume") &&
    host.session == null &&
    session !== undefined
  )
    throw fail(
      "AUTH_DEVICE_MISMATCH",
      "The token does not bind the claimed session",
    );
  if (
    (project?.id ?? host.project) !== host.project ||
    project?.root !== undefined
  )
    throw fail(
      "INPUT_INVALID",
      "context.project must be the admitted project, with no root",
    );
  if (call.dryRun === true && op !== "lane.stop")
    throw fail("UNAVAILABLE", "this profile has no dry-run execution contract");
  const bound = bindContext(operations[op]!, {
    ...rest,
    project: { id: host.project },
    ...(session === undefined
      ? {}
      : { session: { ...session, device: host.device } }),
  });
  if (!bound.ok) throw new ForgeFailure(bound.error);
  return {
    requestId: call.requestId as string,
    op,
    input: call.input,
    context: bound.context,
    ...(call.dryRun === true ? { dryRun: true as const } : {}),
  };
}

/** The envelope's op, input and bound context: what a read needs, without the request id. */
export function prepareCommand(
  text: string,
  host: CommandHost,
): Omit<PreparedCommand, "requestId"> {
  const { requestId: _id, ...prepared } = parseCommand(text, host);
  return prepared;
}

// The cloud has no labelOrder setting yet (forge-1250), so ready issues stay in key order.
const readyIssues: typeof listIssues = (views, input, now, prefix) =>
  listIssues(views, input, now, prefix, { labelOrder: [] });

const blockedIssues: typeof listIssues = (views, input, now, prefix) =>
  listIssues(views, input, now, prefix, undefined, "blocked");
const staleIssues: typeof listIssues = (views, input, now, prefix) =>
  listIssues(views, input, now, prefix, undefined, "stale");

export interface CommandRun extends CommandHost {
  readonly principal: ReceiptPrincipal;
  readonly storage: DurableStorage;
  /** The server's configured id prefix, as set: readIssue checks it. */
  readonly idPrefix: unknown;
  readonly now: number;
  readonly approvalConfig?: Readonly<Record<string, unknown>>;
  /** Throws when the token is no longer valid; a write calls it inside its transaction. */
  readonly recheck: () => void;
  /** When the token expires, in milliseconds. */
  readonly expiresAt?: number | undefined;
  /** Opens the project database for a write; reads never call it. */
  readonly open: () => { db: SqlDatabase; owner: StateOwner };
}

// Each view is built on first use and then kept, so a request that never reaches the work tables
// never probes them.
function lazyViews(storage: DurableStorage): IssueViews {
  const built: {
    records?: [ReturnType<typeof readOnlyStore>];
    leases?: [ReturnType<typeof readOnlyStore>];
  } = {};
  return {
    get records() {
      return (built.records ??= [
        readOnlyStore(storage, "state_records", RECORD_READS),
      ])[0];
    },
    get leases() {
      return (built.leases ??= [
        readOnlyStore(storage, "state_leases", LEASE_READS),
      ])[0];
    },
  };
}

/**
 * Runs an exposed command and measures the serialized response in UTF-8 bytes.
 * Throws ForgeFailure when refused and runs no await, so the caller's token check stays current.
 */
export function runCommand(text: string, host: CommandRun): Response {
  const call = parseCommand(text, host);
  const { requestId, op, input, context } = call;
  const read =
    op === "issue.show"
      ? readIssue
      : op === "issue.comments"
        ? listComments
        : op === "issue.links"
          ? listLinks
          : op === "issue.list"
            ? listIssues
            : op === "issue.ready"
              ? readyIssues
              : op === "issue.blocked"
                ? blockedIssues
                : op === "issue.stale"
                  ? staleIssues
                  : undefined;
  const write =
    op === "issue.create"
      ? createIssue
      : op === "issue.comment"
        ? commentIssue
        : op === "issue.update"
          ? updateIssue
          : op === "issue.dep"
            ? depIssue
            : op === "issue.link"
              ? linkIssue
              : op === "issue.close"
                ? closeIssue
                : op === "issue.claim"
                  ? claimIssue
                  : op === "issue.renew"
                    ? renewIssue
                    : op === "issue.release"
                      ? releaseIssue
                      : undefined;
  let result: unknown;
  if (op === "lane.control" || op === "lane.stop" || op === "lane.resume")
    result = laneCommand(call, host);
  else if (write !== undefined) {
    // Both come before the store is opened, so a refusal never sets up or migrates it.
    if (carriesToken(requestId))
      throw fail("INPUT_INVALID", "requestId must not carry a credential");
    host.recheck();
    const scoped = scopeRequestId("command", host.principal, requestId);
    const { db, owner } = host.open();
    guardLegacy(db, requestId, scoped);
    result = write(db, owner, {
      requestId,
      principal: host.principal,
      input,
      context,
      device: host.device,
      prefix: host.idPrefix,
      recheck: host.recheck,
      expiresAt: host.expiresAt,
    });
  } else if (read !== undefined)
    result = read(
      lazyViews(host.storage),
      input,
      host.now,
      host.idPrefix as string,
    );
  else throw fail("INPUT_INVALID", "Commands are not yet supported in cloud");
  const approvalRequired =
    op === "lane.resume" &&
    typeof result === "object" &&
    result !== null &&
    "request" in result;
  const body = JSON.stringify(
    approvalRequired
      ? {
          ...failure("APPROVAL_REQUIRED", "Fresh owner approval is required"),
          op,
          result,
        }
      : {
          ok: true,
          op,
          status: "OK",
          result,
          warnings: [],
        },
  );
  if (new TextEncoder().encode(body).length > MAX_SHOW_RESPONSE_BYTES)
    throw fail("UNAVAILABLE", "response too large");
  return new Response(body, {
    status: approvalRequired ? 409 : 200,
    headers: { "content-type": "application/json" },
  });
}
