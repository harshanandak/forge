// The config codec over the `yaml` package (decision 5): YAML 1.2 core schema in strict mode. Text
// from disk is untrusted, so decoding refuses duplicate keys, aliases, custom tags and non-JSON
// values, and enforces the parse budgets before and after parsing.
import { parseDocument, stringify } from "yaml";
import type { ForgeError, ParseLimits } from "../../generated/types.ts";
import type {
  ConfigCodecPort,
  DecodeResult,
} from "../../ports/config-codec.ts";

function refuse(message: string): DecodeResult {
  return {
    ok: false,
    error: { code: "INPUT_INVALID", message, retry: "never" },
  };
}

function overLimit(name: keyof ParseLimits, limit: number): DecodeResult {
  const error: ForgeError = {
    code: "LIMIT_EXCEEDED",
    message: `config text exceeds the ${name} limit of ${limit}`,
    expected: { [name]: limit },
    retry: "never",
  };
  return { ok: false, error };
}

/** Walk the decoded value: JSON types only, no prototype keys, and within the budgets. */
function checkValue(
  root: unknown,
  limits: ParseLimits,
): DecodeResult | undefined {
  let nodes = 0;
  const pending: Array<{ value: unknown; depth: number; at: string }> = [
    { value: root, depth: 1, at: "" },
  ];
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined) break;
    const { value, depth, at } = item;
    nodes += 1;
    if (nodes > limits.maxNodes) return overLimit("maxNodes", limits.maxNodes);
    if (depth > limits.maxDepth) return overLimit("maxDepth", limits.maxDepth);
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "string") {
      if (value.length > limits.maxStringLength)
        return overLimit("maxStringLength", limits.maxStringLength);
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value))
        return refuse(
          `${at || "/"} is not a finite number; config holds JSON values only`,
        );
      continue;
    }
    if (Array.isArray(value)) {
      for (const [index, child] of value.entries())
        pending.push({ value: child, depth: depth + 1, at: `${at}/${index}` });
      continue;
    }
    if (
      typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype
    ) {
      for (const [key, child] of Object.entries(value)) {
        if (key === "__proto__")
          return refuse(
            `${at || "/"} uses the key "__proto__", which config does not allow`,
          );
        if (key.length > limits.maxStringLength)
          return overLimit("maxStringLength", limits.maxStringLength);
        pending.push({ value: child, depth: depth + 1, at: `${at}/${key}` });
      }
      continue;
    }
    return refuse(
      `${at || "/"} is not a JSON value; config holds JSON values only`,
    );
  }
  return undefined;
}

export const yamlConfigCodec: ConfigCodecPort = {
  decode(text: string, limits: ParseLimits): DecodeResult {
    if (new TextEncoder().encode(text).length > limits.maxBytes)
      return overLimit("maxBytes", limits.maxBytes);
    const document = parseDocument(text, {
      version: "1.2",
      schema: "core",
      strict: true,
      uniqueKeys: true,
      merge: false,
      prettyErrors: true,
    });
    const [problem] = [...document.errors, ...document.warnings];
    if (problem !== undefined) {
      return refuse(
        `config is not valid strict YAML: ${problem.message.trim()}`,
      );
    }
    let value: unknown;
    try {
      value = document.toJS({ maxAliasCount: 0 });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return refuse(
        `config uses YAML aliases, which are not allowed (${reason})`,
      );
    }
    return (
      checkValue(value ?? null, limits) ?? { ok: true, value: value ?? null }
    );
  },

  encode(value: unknown): string {
    return stringify(value, { lineWidth: 0, version: "1.2" });
  },
};
