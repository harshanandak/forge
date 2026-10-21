import type { McpCandidate } from "../contract/mcp.ts";
import { cliWords, flagName } from "../contract/naming.ts";
import { renderExample } from "../contract/example.ts";
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

function schemaType(value: unknown): string {
  const schema = record(value);
  if (schema?.type === "array") return `${schemaType(schema.items)}[]`;
  if (typeof schema?.type === "string") return schema.type;
  if (Array.isArray(schema?.type)) return schema.type.join(" | ");
  if (Array.isArray(schema?.enum)) return schema.enum.map(String).join(" | ");
  for (const key of ["oneOf", "anyOf"])
    if (Array.isArray(schema?.[key]))
      return schema[key].map(schemaType).join(" | ");
  return "JSON";
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
      "Run forge <noun> --help for verbs; forge <noun> <verb> --help for flags and examples.",
    );
  } else {
    lines.push("Commands:");
    for (const entry of entries) {
      lines.push(
        `  ${synopsis(entry)}`,
        `    ${entry.docs.summary.replace(/\s+/g, " ")}`,
      );
      if (!op.endsWith(".")) {
        lines.push(
          `    Example: ${renderExample(entry.op, entry.docs, entry.argumentSchema ?? entry.inputSchema, entry.declaration.args)}`,
          "",
          "Arguments:",
        );
        const schema = entry.argumentSchema ?? entry.inputSchema;
        const required = Array.isArray(schema.required) ? schema.required : [];
        for (const [key, value] of Object.entries(
          record(schema.properties) ?? {},
        )) {
          const property = record(value);
          const meaning =
            typeof property?.description === "string"
              ? property.description.replace(/\s+/g, " ").trim()
              : `Set ${key.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)}.`;
          lines.push(
            `  --${flagName(key)} <${schemaType(value)}> (${required.includes(key) ? "required" : "optional"})  ${meaning}`,
          );
        }
      }
      lines.push("");
    }
    if (entries.length === 0) lines.push("  No matching commands.", "");
    else if (!op.endsWith("."))
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
