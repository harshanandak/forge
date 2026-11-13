import { isPlainJson } from "./plain-json.ts";

const BODY_BYTES = 256 * 1024,
  TOTAL_BYTES = 1024 * 1024,
  JSON_KEYS = 16_384;
type Refusal = Readonly<{
  ok: false;
  code: "INPUT_INVALID" | "UNAVAILABLE";
  reason: string;
}>;
type State = { bytes: number; keys: number; refusal?: Refusal };
const brand = Symbol("GitHub JSON budget"),
  states = new WeakMap<object, State>();
export function createGithubJsonBudget() {
  const budget = Object.freeze({ [brand]: true });
  states.set(budget, { bytes: 0, keys: 0 });
  return budget;
}
export type GithubJsonBudget = ReturnType<typeof createGithubJsonBudget>;

/** Reuse one budget and signal across a read; any refusal invalidates earlier pages. */
export async function parseGithubJson(
  response: Pick<Response, "body" | "headers">,
  budget: GithubJsonBudget,
  signal: AbortSignal,
): Promise<{ ok: true; value: unknown } | Refusal> {
  const state = states.get(budget);
  const refuse = (code: Refusal["code"] = "UNAVAILABLE"): Refusal => {
    const refusal: Refusal = Object.freeze({
      ok: false,
      code,
      reason:
        code === "INPUT_INVALID"
          ? "Invalid GitHub JSON"
          : "GitHub JSON unavailable",
    });
    if (state) return (state.refusal ??= refusal);
    return refusal;
  };
  let detach = () => {},
    cancel = () => {
      void response.body?.cancel().catch(() => {});
    };
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error(refuse().reason);
    let cancelled = false;
    cancel = () => {
      if (cancelled) return;
      cancelled = true;
      void reader.cancel().catch(() => {});
      try {
        reader.releaseLock();
      } catch {
        // A pending read must not prevent cancellation from completing.
      }
    };
    if (!state || state.refusal || signal.aborted)
      throw new Error(refuse().reason);
    const interrupted = new Promise<null>((resolve) => {
      const abort = () => {
        resolve(null);
        cancel();
      };
      signal.addEventListener("abort", abort, { once: true });
      detach = () => signal.removeEventListener("abort", abort);
    });
    const reading = async (): Promise<{ ok: true; value: unknown }> => {
      const media = response.headers.get("Content-Type") ?? "";
      if (
        !/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)(?:\s*;.*)?$/i.test(
          media,
        )
      )
        throw new Error(refuse().reason);
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let body = "",
        size = 0;
      for (;;) {
        const chunk = await reader.read();
        if (signal.aborted || state.refusal) throw new Error(refuse().reason);
        if (chunk.done) break;
        const value: unknown = chunk.value;
        if (!(value instanceof Uint8Array) || value.byteLength === 0)
          throw new Error(refuse().reason);
        size += value.byteLength;
        state.bytes += value.byteLength;
        if (size > BODY_BYTES || state.bytes > TOTAL_BYTES)
          throw new Error(refuse().reason);
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
      // Syntax accounting precedes parsing, so overwritten and unknown keys are charged.
      // This token scan is separate from the shared descriptor/depth/node guard.
      const stack: string[] = [];
      let previous = "";
      for (const match of body.matchAll(
        /"(?:[^"\\]|\\[\s\S])*"|[{}[\],:]|[^\s{}[\],:]+/g,
      )) {
        const token = match[0];
        if (
          (token === ":" ||
            (stack.at(-1) === "[" &&
              (previous === "[" || previous === ",") &&
              token !== "]")) &&
          ++state.keys > JSON_KEYS
        )
          throw new Error(refuse("INPUT_INVALID").reason);
        if (token === "[" || token === "{") stack.push(token);
        if (token === "]" || token === "}") stack.pop();
        previous = token;
      }
      const value: unknown = JSON.parse(body);
      if (!isPlainJson(value)) throw new Error(refuse("INPUT_INVALID").reason);
      return { ok: true, value };
    };
    return (await Promise.race([reading(), interrupted])) ?? refuse();
  } catch {
    return refuse();
  } finally {
    detach();
    cancel();
  }
}
