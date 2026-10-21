import type { McpCandidate } from "../contract/mcp.ts";
import { cliWords, flagName } from "../contract/naming.ts";
import { record } from "./dispatch.ts";

function synopsis(entry: McpCandidate): string {
  const schema = entry.argumentSchema ?? entry.inputSchema;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const positional = entry.declaration.args ?? [];
  return [
    ...(cliWords(entry.op) ?? [entry.op]),
    ...positional.map((key) =>
      required.includes(key) ? `<${key}>` : `[${key}]`,
    ),
    ...required
      .filter(
        (key): key is string =>
          typeof key === "string" && !positional.includes(key),
      )
      .map((key) => `--${flagName(key)} <${key}>`),
  ].join(" ");
}

function example(entry: McpCandidate): string {
  const schema = entry.argumentSchema ?? entry.inputSchema;
  const words = (cliWords(entry.op) ?? [entry.op]).join(" ");
  const command = entry.docs.examples?.[0]?.command;
  if (command !== undefined) {
    const noun = /^forge ([a-z][a-z0-9-]*) /.exec(command)?.[1];
    return noun === undefined
      ? command
      : command.replaceAll(
          `forge ${noun} `,
          `forge ${entry.op.split(".")[0]} `,
        );
  }
  const input = entry.docs.examples?.[0]?.input;
  if (input !== undefined && Object.keys(record(input) ?? {}).length > 0)
    return `forge ${words} --input '${JSON.stringify(input).replaceAll("'", "'\\''")}'`;
  if (!Array.isArray(schema.required) || schema.required.length === 0)
    return `forge ${words}`;
  return `forge ${words} --help --json`;
}

/** Render only catalog metadata; asking for help never invokes an operation. */
export function renderHelp(
  entries: readonly McpCandidate[],
  op?: string,
): string {
  const lines = [
    `Usage: forge${op === undefined ? " <noun> <verb>" : ` ${op.replaceAll(".", " ").trimEnd()}${op.endsWith(".") ? " <verb>" : ""}`} [arguments] [flags]`,
    "",
  ];
  if (op === undefined) {
    lines.push("Commands:");
    const nouns = [
      ...new Set(entries.map((entry) => entry.op.split(".")[0]!)),
    ].sort();
    for (const noun of nouns)
      lines.push(
        `  ${noun.padEnd(14)} ${entries
          .filter((entry) => entry.op.startsWith(`${noun}.`))
          .map((entry) => entry.op.split(".")[1])
          .join(", ")}`,
      );
    lines.push(
      "",
      "Run forge <noun> --help for verbs, required arguments and examples.",
    );
  } else {
    lines.push("Commands:");
    for (const entry of entries) {
      lines.push(
        `  ${synopsis(entry)}`,
        `    ${entry.docs.summary.replace(/\s+/g, " ")}`,
        `    Example: ${example(entry)}`,
        "",
      );
    }
    if (entries.length === 0) lines.push("  No matching commands.", "");
    else
      lines.push(
        "Use existing records and files in examples; read current ids and revisions first.",
        "",
      );
  }
  lines.push(
    "Flags:",
    "  -h, --help     Show help",
    "  --input JSON   Pass operation arguments as JSON",
    "  --text         Render operation results as text (default: JSON)",
    "  --mcp          Start the MCP stdio server",
    "  -v, --version  Print the installed version",
    "",
    "Full contract: add --json to help (forge --help --json).",
    "",
  );
  return lines.join("\n");
}
