// The untrusted-input boundary is the byte/text parse. Budgets for size, depth, node count and
// string length apply there, before and while the text becomes data. Objects handed in by a trusted
// embedding are trusted input with stated limits; no promise is made about traversing arbitrary
// JavaScript objects (a Proxy can run code when inspected).
import type {
  ForgeError,
  ParseLimits,
  UntrustedContent,
} from "../generated/types.ts";

export const DEFAULT_PARSE_LIMITS: ParseLimits = {
  maxBytes: 1_048_576,
  maxDepth: 64,
  maxNodes: 100_000,
  maxStringLength: 262_144,
};

export type ParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: ForgeError };

function limitExceeded(name: string, limit: number): ParseResult {
  return {
    ok: false,
    error: {
      code: "LIMIT_EXCEEDED",
      message: `input exceeds the ${name} limit of ${limit}`,
      expected: { [name]: limit },
      retry: "never",
    },
  };
}

/** Deepest bracket nesting outside strings, found without parsing. */
function nestingDepth(text: string): number {
  let depth = 0;
  let deepest = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (ch === 0x5c) i += 1;
      else if (ch === 0x22) inString = false;
    } else if (ch === 0x22) {
      inString = true;
    } else if (ch === 0x7b || ch === 0x5b) {
      depth += 1;
      if (depth > deepest) deepest = depth;
    } else if (ch === 0x7d || ch === 0x5d) {
      depth -= 1;
    }
  }
  return deepest;
}

/** Parse JSON from outside the trust boundary under explicit budgets. */
export function parseUntrustedJson(
  input: string | Uint8Array,
  limits: ParseLimits = DEFAULT_PARSE_LIMITS,
): ParseResult {
  let text: string;
  if (typeof input === "string") {
    if (new TextEncoder().encode(input).length > limits.maxBytes) {
      return limitExceeded("maxBytes", limits.maxBytes);
    }
    text = input;
  } else {
    if (input.length > limits.maxBytes)
      return limitExceeded("maxBytes", limits.maxBytes);
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      return {
        ok: false,
        error: {
          code: "INPUT_INVALID",
          message: "input is not valid UTF-8",
          retry: "never",
        },
      };
    }
  }
  if (nestingDepth(text) > limits.maxDepth)
    return limitExceeded("maxDepth", limits.maxDepth);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "INPUT_INVALID",
        message: `input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        retry: "never",
      },
    };
  }
  let nodes = 0;
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    nodes += 1;
    if (nodes > limits.maxNodes)
      return limitExceeded("maxNodes", limits.maxNodes);
    if (typeof node === "string" && node.length > limits.maxStringLength) {
      return limitExceeded("maxStringLength", limits.maxStringLength);
    }
    if (Array.isArray(node)) {
      // no spread: an array of 500k elements would exceed the engine's argument limit
      if (nodes + pending.length + node.length > limits.maxNodes) {
        return limitExceeded("maxNodes", limits.maxNodes);
      }
      for (const child of node as unknown[]) pending.push(child);
    } else if (typeof node === "object" && node !== null) {
      for (const [key, child] of Object.entries(node)) {
        if (key.length > limits.maxStringLength) {
          return limitExceeded("maxStringLength", limits.maxStringLength);
        }
        pending.push(child);
      }
    }
  }
  return { ok: true, value };
}

/** Fence text from outside the trust boundary with its provenance; it is data, never instructions. */
export function fenceUntrusted(
  text: string,
  source: string,
  receivedAt?: string,
): UntrustedContent {
  return receivedAt === undefined
    ? { kind: "untrusted", source, text }
    : { kind: "untrusted", source, receivedAt, text };
}
