import { cliWords, flagName, RESERVED_FLAGS } from "./naming.ts";
import type { OperationDocs } from "../generated/types.ts";
import type { SchemaObject } from "./schema.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function quote(raw: string, shell: string, scalar: boolean): string {
  if (/^[a-zA-Z0-9_./:@=-]+$/.test(raw)) return raw;
  if (scalar && !/["\\$`%!]/.test(raw)) return `"${raw}"`;
  if (shell === "POSIX") return `'${raw.replaceAll("'", "'\\''")}'`;
  // Scalar native quotes are doubled, with 2n backslashes before them or the closing quote.
  // Quote pairs keep PowerShell 5.1's quote-count heuristic from re-wrapping scalar spaces.
  const native = raw
    .replace(/(\\*)"/g, scalar ? '$1$1""' : '$1$1\\"')
    .replace(/(\\+)$/g, scalar || shell === "cmd" ? "$1$1" : "$1");
  return shell === "cmd"
    ? `"${native}"`.replace(/[%^"&|<>]/g, "^$&")
    : `'${(scalar ? `"${native}"` : native).replaceAll("'", "''")}'`;
}

/** One shell-aware renderer for documented calls in help and diagnostics. */
export function renderExample(
  op: string,
  docs: OperationDocs,
  schema: SchemaObject,
  positions: readonly string[] = [],
): string {
  const words = (cliWords(op) ?? [op]).join(" ");
  const command = docs.examples?.[0]?.command;
  if (command !== undefined) {
    return docs
      .examples!.flatMap((item) => {
        if (item.command === undefined) return [];
        const noun = /\bforge ([a-z][a-z0-9-]*) /.exec(item.command)?.[1];
        return [
          noun === undefined
            ? item.command
            : item.command.replaceAll(
                `forge ${noun} `,
                `forge ${op.split(".")[0]} `,
              ),
        ];
      })
      .join("\n    ");
  }
  const input = docs.examples?.[0]?.input;
  const nonObject = input !== undefined && record(input) === undefined;
  if (nonObject || Object.keys(record(input) ?? {}).length > 0) {
    const properties = record(schema.properties) ?? {};
    const values = Object.entries(record(input) ?? { input });
    const args = values.every(
      ([key, value]) =>
        !nonObject &&
        Object.hasOwn(properties, key) &&
        !RESERVED_FLAGS.includes(flagName(key) ?? "") &&
        (typeof value === "string" ||
          record(properties[key])?.type !== undefined),
    )
      ? values
      : [["input", input] as const];
    const positional = positions.every((key) =>
      Object.hasOwn(record(input) ?? {}, key),
    )
      ? positions
      : [];
    const ordered = [
      ...args.filter(([key]) => !positional.includes(key)),
      ...positional.flatMap((key) => args.filter(([name]) => name === key)),
    ];
    const render = (shell: string): string =>
      `forge ${words} ${ordered
        .map(([key, value]) => {
          const type = record(properties[key])?.type;
          const scalar = typeof value === "string" && !nonObject;
          const raw =
            scalar && (type === "string" || type === undefined)
              ? value
              : JSON.stringify(value);
          const nativeRaw =
            shell === "PowerShell 5.1" && !scalar
              ? raw.replace(
                  /\s/g,
                  (character) =>
                    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
                )
              : raw;
          const quoted = quote(nativeRaw, shell, scalar);
          return positional.includes(key)
            ? quoted
            : `--${flagName(key)} ${quoted}`;
        })
        .join(" ")}`;
    const shells = ["POSIX", "PowerShell 5.1", "cmd"];
    const commands = shells.map(render);
    // PowerShell 5.1 splits whitespace inside escaped JSON quotes; JSON escapes preserve it.
    return commands.every((command) => command === commands[0])
      ? commands[0]!
      : commands
          .map((command, index) => `${shells[index]}: ${command}`)
          .join("\n    ");
  }
  if (!Array.isArray(schema.required) || schema.required.length === 0)
    return `forge ${words}`;
  return `forge ${words} --help --json`;
}
