// The skills surface: one SKILL.md per block noun, generated from catalog metadata only, next to
// the generated CLI and MCP surfaces. The lint (D9) keeps any skill honest against the catalog.
import {
  isAgentCallable,
  renamedOperation,
  type McpCandidate,
} from "../contract/mcp.ts";
import {
  CORE_NOUNS,
  cliWords,
  flagName,
  mcpToolName,
  parseOperationName,
} from "../contract/naming.ts";
import { record } from "./dispatch.ts";
import { discoveryOperations } from "./discovery.ts";

/** D9 ceiling: a skill larger than this fails the lint. */
export const SKILL_MAX_BYTES = 8192;
/** Harnesses truncate or reject longer skill descriptions. */
export const SKILL_DESCRIPTION_MAX = 1024;

export interface SkillFile {
  readonly noun: string;
  /** Relative to the skills directory, "/"-separated. */
  readonly path: string;
  readonly text: string;
}

function typeOf(schema: unknown): string {
  const s = record(schema);
  if (s === undefined) return "any";
  if (Array.isArray(s.enum))
    return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  if ("const" in s) return JSON.stringify(s.const);
  if (typeof s.$ref === "string") return s.$ref.split("/").pop() ?? "object";
  const alternatives = s.anyOf ?? s.oneOf;
  if (Array.isArray(alternatives)) return alternatives.map(typeOf).join(" | ");
  if (s.type === "array") return `${typeOf(s.items)}[]`;
  if (Array.isArray(s.type)) return s.type.join(" | ");
  return typeof s.type === "string" ? s.type : "any";
}

/** Top-level fields only; the full schema stays one `catalog describe` away. */
function shape(schema: unknown): string {
  const properties = record(record(schema)?.properties);
  if (properties === undefined) return `\`${typeOf(schema)}\``;
  const required = record(schema)?.required;
  const fields = Object.entries(properties).map(
    ([key, value]) =>
      `\`${key}${Array.isArray(required) && required.includes(key) ? "" : "?"}\` ${typeOf(value)}`,
  );
  return fields.length === 0 ? "none" : fields.join(", ");
}

/** What the CLI parser expects after a value flag: raw text, a number, or JSON for anything else. */
function placeholder(schema: unknown): string {
  const type = record(schema)?.type;
  if (type === undefined || type === "string") return "<text>";
  return type === "integer" || type === "number" ? "<number>" : "<json>";
}

/** `forge <noun> <verb>` usage: positionals, then required flags, then optional ones in brackets. */
function usage(candidate: McpCandidate): string {
  const [noun, verb] = cliWords(candidate.op) ?? [candidate.op, ""];
  // Flags map onto object properties only; any other input goes in whole as JSON.
  if (
    candidate.inputSchema.properties === undefined &&
    candidate.inputSchema.type !== "object"
  )
    return `forge ${noun} ${verb} --input <json>`;
  const properties = record(candidate.inputSchema.properties) ?? {};
  const listed = candidate.inputSchema.required;
  const required = new Set(Array.isArray(listed) ? listed : []);
  const args = candidate.declaration.args ?? [];
  const optional = (part: string, key: string): string =>
    required.has(key) ? part : `[${part}]`;
  const flags = Object.keys(properties)
    .filter((key) => !args.includes(key))
    .flatMap((key) => {
      const flag = flagName(key);
      if (flag === undefined) return [];
      const value =
        record(properties[key])?.type === "boolean"
          ? ""
          : ` ${placeholder(properties[key])}`;
      return [{ key, part: optional(`--${flag}${value}`, key) }];
    })
    .sort((a, b) => Number(required.has(b.key)) - Number(required.has(a.key)));
  return [
    "forge",
    noun,
    verb,
    ...args.map((arg) => optional(`<${arg}>`, arg)),
    ...flags.map((f) => f.part),
  ].join(" ");
}

function section(candidate: McpCandidate, prefix: string | undefined): string {
  const { op, declaration, docs } = candidate;
  const effects =
    declaration.effects.length === 0
      ? "none (read-only)"
      : declaration.effects.map((e) => `\`${e}\``).join(", ");
  const example = docs.examples?.[0];
  const declared = declaration.deprecated?.use;
  const deprecated =
    declared === undefined
      ? undefined
      : renamedOperation(declared, candidate.rename);
  return [
    `## \`${op}\` — ${docs.title}`,
    "",
    ...(deprecated === undefined ? [] : [`Deprecated: use \`${deprecated}\`.`]),
    docs.summary,
    "",
    `- CLI: \`${usage(candidate)}\``,
    `- MCP: \`${mcpToolName(op, prefix) ?? "catalog_call"}\``,
    `- Input: ${shape(candidate.inputSchema)}`,
    `- Output: ${candidate.outputSchema === undefined ? "none" : shape(candidate.outputSchema)}`,
    `- Effects: ${effects}; ${declaration.idempotent ? "idempotent" : "not idempotent"}`,
    ...(example === undefined
      ? []
      : [`- Example input: \`${JSON.stringify(example.input)}\``]),
    "",
  ].join("\n");
}

function describe(noun: string, agent: readonly McpCandidate[]): string {
  const verbs = agent.map((c) => parseOperationName(c.op)?.verb).join(", ");
  let text = `Forge ${noun} operations (${verbs}), callable from the CLI or MCP.`;
  for (const candidate of agent) {
    const next = `${text} ${candidate.docs.summary}`;
    if (next.length > SKILL_DESCRIPTION_MAX) break;
    text = next;
  }
  return text.replace(/\s+/g, " ");
}

function skill(
  noun: string,
  entries: readonly McpCandidate[],
  prefix: string | undefined,
): string {
  const agent = entries.filter((c) => isAgentCallable(c.declaration));
  const human = entries.filter((c) => !isAgentCallable(c.declaration));
  return [
    "---",
    `name: ${noun}`,
    `description: ${JSON.stringify(describe(noun, agent))}`,
    "---",
    "",
    `# ${noun}`,
    "",
    "Generated from the Forge catalog; rerun forge skills sync after the catalog changes instead of editing this file.",
    "Every call returns a JSON result envelope. When an MCP tool below is not listed, use `catalog_call` with the operation name and input; `catalog_describe` returns the full schemas.",
    "",
    ...agent.map((c) => section(c, prefix)),
    ...(human.length === 0
      ? []
      : [
          "## Human only",
          "",
          "Agents cannot call these; ask a person to run them:",
          "",
          ...human.map((c) => `- \`${c.op}\`: ${c.docs.summary}`),
          "",
        ]),
  ].join("\n");
}

/** One skill per block noun with at least one agent-callable operation; sorted, so output is stable. */
export function renderSkills(
  candidates: readonly McpCandidate[],
  prefix?: string,
): readonly SkillFile[] {
  const byNoun = new Map<string, McpCandidate[]>();
  for (const candidate of [...candidates].sort((a, b) =>
    a.op < b.op ? -1 : a.op > b.op ? 1 : 0,
  )) {
    const noun = parseOperationName(candidate.op)?.noun;
    if (noun === undefined || CORE_NOUNS.includes(noun)) continue;
    byNoun.set(noun, [...(byNoun.get(noun) ?? []), candidate]);
  }
  return [...byNoun]
    .filter(([, entries]) =>
      entries.some((c) => isAgentCallable(c.declaration)),
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([noun, entries]) => ({
      noun,
      path: `${noun}/SKILL.md`,
      text: skill(noun, entries, prefix),
    }));
}

const NAME = "[a-z][a-z0-9-]*";
const CLI_FORM = new RegExp(`^forge (${NAME}) (${NAME})(?:\\s|$)`);
const OP_FORM = new RegExp(`^(${NAME})[._](${NAME})$`);

/**
 * D9: a skill must fit the size ceiling, carry a name and description, and name only operations
 * the catalog has. Operation names are read from code spans: `noun.verb`, `noun_verb` and
 * `forge noun verb`; a dotted or underscored span counts only when its noun is a catalog noun.
 */
export function lintSkill(
  text: string,
  candidates: readonly McpCandidate[],
  prefix?: string,
  maxBytes: number = SKILL_MAX_BYTES,
): readonly string[] {
  const problems: string[] = [];
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > maxBytes)
    problems.push(`skill is ${bytes} bytes; the limit is ${maxBytes}`);
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
  if (!/^name: \S/m.test(front)) problems.push("frontmatter has no name");
  const description = /^description: (.*)$/m.exec(front)?.[1];
  if (description === undefined)
    problems.push("frontmatter has no description");
  else if (description.length > SKILL_DESCRIPTION_MAX + 2)
    problems.push(`description exceeds ${SKILL_DESCRIPTION_MAX} characters`);
  const known = new Set(
    [...discoveryOperations, ...candidates].map((c) => c.op),
  );
  const nouns = new Set(
    [...known].map((op) => parseOperationName(op)?.noun ?? op),
  );
  for (const [, span = ""] of text.matchAll(/`([^`\n]+)`/g)) {
    const bare =
      prefix !== undefined && span.startsWith(`${prefix}_`)
        ? span.slice(prefix.length + 1)
        : span;
    const cli = CLI_FORM.exec(span);
    const named = cli ?? OP_FORM.exec(bare);
    if (named === null) continue;
    const op = `${named[1]}.${named[2]}`;
    if (!known.has(op) && (cli !== null || nouns.has(named[1] ?? "")))
      problems.push(`unknown operation ${op} in \`${span}\``);
  }
  return problems;
}
