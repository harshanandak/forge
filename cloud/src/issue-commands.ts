// POST /p/<project>/command: typed issue commands at the project authority.
// This slice is the guarded route only: the Worker, the configured Worker and the object each refuse
// what a command may not carry. Every command that passes the guards is refused as not yet
// supported, and nothing is written.
import { ForgeFailure } from "../../src/contract/failure.ts";
import type {
  BoundContext,
  ForgeError,
  ResultEnvelope,
} from "../../src/generated/types.ts";

export const MAX_COMMAND_BODY = 512 * 1024;
const COMMAND_ROUTE = /^\/p\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/command$/;

/** The project a command route names, or undefined when the path is not the command route. */
export const commandProject = (request: Request): string | undefined =>
  COMMAND_ROUTE.exec(new URL(request.url).pathname)?.[1];

export const failed = (error: ForgeError): ResultEnvelope => ({
  ok: false,
  status: "FAIL",
  error,
  warnings: [],
});

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

/** Stub: the envelope and context checks arrive with the next commit. */
export function prepareCommand(
  _text: string,
  _host: CommandHost,
): PreparedCommand {
  throw new ForgeFailure({
    code: "INPUT_INVALID",
    message: "Commands are not yet supported in cloud",
    retry: "never",
  });
}
