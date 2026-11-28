import { parseConsumeRequest } from "./lane-step-contract.ts";
import type {
  ConsumeResult,
  InspectRefusal,
  InspectRequest,
} from "./lane-step-contract.ts";
import type { InspectReads } from "./lane-step.ts";

export type ConsumeReads = InspectReads & {
  readonly control: (
    issue: string,
  ) => Promise<"running" | "stopped" | "unknown">;
};
export type PreflightRequest = Omit<InspectRequest, "brief"> & {
  readonly brief: Readonly<{ path?: string; digest: string }>;
};
type Verify = (
  request: PreflightRequest,
) => Promise<InspectRefusal | { bytes: Uint8Array }>;

export async function consumeBrief(
  input: unknown,
  verify: Verify,
): Promise<ConsumeResult> {
  const request = parseConsumeRequest(input);
  if ("status" in request) return request;
  const { head, digest, ...target } = request.context;
  const result = await verify({
    ...target,
    expectedHead: head,
    brief: { digest },
  });
  if ("status" in result) return result;
  return { status: "verified", brief: result.bytes };
}
