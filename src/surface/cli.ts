import type { McpCandidate } from "../contract/mcp.ts";
import { propertyFromFlag } from "../contract/naming.ts";
import type { SurfaceCatalog } from "./catalog.ts";
import {
  dispatch,
  record,
  success,
  visible,
  type CallOptions,
} from "./dispatch.ts";
import { failure, respond, type SurfaceResponse } from "./result.ts";
import { discoveryOperations } from "./discovery.ts";
import { renderHelp } from "./help.ts";

const builtins = discoveryOperations.map((entry) => entry.op);

function help(catalog: SurfaceCatalog, options: CallOptions, op?: string) {
  const entries = visible(catalog, options.caller);
  return {
    usage: "forge <noun> <verb> [arguments] [--input JSON] [--text]",
    options: [
      "--help",
      "--json (full help contract; default for operation results)",
      "--text",
      "--input JSON",
      "--dry-run",
      "--hook <noun.verb> (JSON stdin)",
      "--mcp (assembled stdio transport)",
    ],
    operations:
      op === undefined
        ? entries
        : entries.filter(
            (c) => c.op === op || (op.endsWith(".") && c.op.startsWith(op)),
          ),
  };
}

function argumentValue(raw: string, schema: unknown): unknown {
  const type = record(schema)?.type;
  if (type === "string" || type === undefined) return raw;
  const value: unknown = JSON.parse(raw);
  if (type === "integer" && !Number.isInteger(value))
    throw new Error("Expected an integer.");
  if (type === "number" && typeof value !== "number")
    throw new Error("Expected a number.");
  if (type === "boolean" && typeof value !== "boolean")
    throw new Error("Expected a boolean.");
  return value;
}

function mapArguments(
  tokens: readonly string[],
  entry: McpCandidate | undefined,
): unknown {
  const properties =
    record((entry?.argumentSchema ?? entry?.inputSchema)?.properties) ?? {};
  const positions = entry?.declaration.args ?? [];
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  let position = 0;
  let literal = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (!literal && token === "--") {
      literal = true;
      continue;
    }
    if (!literal && token.startsWith("--")) {
      const [flag = "", inline] = token.slice(2).split(/=(.*)/s);
      const key = propertyFromFlag(flag) ?? "";
      if (!Object.hasOwn(properties, key))
        throw new Error(`Unknown argument --${flag}.`);
      if (Object.hasOwn(result, key))
        throw new Error(`Duplicate argument ${key}.`);
      const type = record(properties[key])?.type;
      const next = tokens[i + 1];
      const booleanSwitch =
        type === "boolean" &&
        inline === undefined &&
        (next === undefined ||
          next.startsWith("--") ||
          !["true", "false"].includes(next));
      const raw = inline ?? (booleanSwitch ? "true" : tokens[++i]);
      if (raw === undefined) throw new Error(`Missing value for --${key}.`);
      result[key] = argumentValue(raw, properties[key]);
    } else {
      const key = positions[position++];
      if (key === undefined)
        throw new Error(
          "Unexpected positional argument. Use declared flags or --input JSON.",
        );
      if (Object.hasOwn(result, key))
        throw new Error(`Duplicate argument ${key}.`);
      result[key] = argumentValue(token, properties[key]);
    }
  }
  return result;
}

/** Parse only surface flags here; operation arguments come exclusively from catalog schemas. */
export async function runCli(
  catalog: SurfaceCatalog,
  argv: readonly string[],
  options: CallOptions = { caller: "agent" },
): Promise<SurfaceResponse> {
  let text = false;
  let helpRequested = false;
  let jsonHelp = false;
  let dryRun = options.dryRun;
  let rawInput: string | undefined;
  const tokens: string[] = [];
  let literal = false;
  try {
    for (let i = 0; i < argv.length; i++) {
      const token = argv[i];
      if (token === undefined) continue;
      if (literal) {
        tokens.push(token);
        continue;
      }
      if (token === "--") {
        literal = true;
        tokens.push(token);
        continue;
      }
      if (token === "--text") {
        text = true;
        jsonHelp = false;
        continue;
      }
      if (token === "--json") {
        text = false;
        jsonHelp = true;
        continue;
      }
      if (token === "--help" || token === "-h") {
        helpRequested = true;
        continue;
      }
      if (token === "--dry-run") {
        dryRun = true;
        continue;
      }
      if (token === "--input" || token.startsWith("--input=")) {
        if (rawInput !== undefined) throw new Error("Duplicate --input.");
        rawInput = token === "--input" ? argv[++i] : token.slice(8);
        if (rawInput === undefined)
          throw new Error("Missing JSON for --input.");
        continue;
      }
      tokens.push(token);
    }
    const first = tokens.shift();
    const op =
      first === undefined
        ? undefined
        : first.includes(".")
          ? first
          : `${first}.${tokens.shift() ?? ""}`;
    if (helpRequested || op === undefined) {
      const result = help(catalog, options, op);
      const response = respond(success("catalog.list", result), text);
      return jsonHelp
        ? response
        : { ...response, stdout: renderHelp(result.operations, op) };
    }
    if (![...builtins, ...catalog.list().map((c) => c.op)].includes(op))
      return respond(await dispatch(catalog, op, {}, options), text);
    let input: unknown;
    if (rawInput !== undefined) {
      if (tokens.length !== 0)
        throw new Error("Do not mix --input with operation arguments.");
      input = JSON.parse(rawInput);
    } else {
      input = mapArguments(
        tokens,
        [...discoveryOperations, ...catalog.list()].find((c) => c.op === op),
      );
    }
    return respond(
      await dispatch(catalog, op, input, {
        ...options,
        ...(dryRun === undefined ? {} : { dryRun }),
      }),
      text,
    );
  } catch (error) {
    return respond(
      failure(
        "INPUT_INVALID",
        error instanceof Error ? error.message : "Invalid arguments.",
      ),
      text,
    );
  }
}
