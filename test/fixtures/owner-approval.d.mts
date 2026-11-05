type Envelope = {
  readonly ok: boolean;
  readonly error?: { readonly code: string };
  readonly result?: unknown;
};
export function approvalReply(
  result: Envelope,
  source?: { harness: string; thread: string },
): {
  request: string;
  quote: string;
  source: { harness: string; thread: string };
};
export function withCliOwnerApproval<
  Extra extends unknown[],
  Result extends Envelope,
>(
  call: (args: string[], expected: number, ...rest: Extra) => Result,
): (args: string[], expected?: number, ...rest: Extra) => Result;
export function withOwnerApproval<
  Extra extends unknown[],
  Result extends Envelope | undefined,
>(
  call: (op: string, input: unknown, ...rest: Extra) => Promise<Result>,
): (op: string, input?: unknown, ...rest: Extra) => Promise<Result>;
export function withOwnerApproval<
  Extra extends unknown[],
  Result extends Envelope | undefined,
>(
  call: (op: string, input: unknown, ...rest: Extra) => Result,
): (op: string, input?: unknown, ...rest: Extra) => Result;
