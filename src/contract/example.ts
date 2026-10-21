import { cliWords, flagName, RESERVED_FLAGS } from "./naming.ts";
import type { OperationDocs } from "../generated/types.ts";
import type { SchemaObject } from "./schema.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
  if (input !== undefined && Object.keys(record(input) ?? {}).length > 0) {
    const properties = record(schema.properties) ?? {};
    const values = Object.entries(record(input) ?? {});
    const args = values.every(
      ([key, value]) =>
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
    const render = (powershell: boolean): string =>
      `forge ${words} ${ordered
        .map(([key, value]) => {
          const type = record(properties[key])?.type;
          const raw =
            typeof value === "string" &&
            (type === "string" || type === undefined)
              ? value
              : JSON.stringify(value);
          const nativeRaw =
            powershell && typeof value !== "string"
              ? raw.replace(
                  /\s/g,
                  (character) =>
                    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
                )
              : raw;
          const quoted = /^[a-zA-Z0-9_./:@=-]+$/.test(raw)
            ? raw
            : typeof value === "string" && !/["\\$`%!]/.test(raw)
              ? `"${raw}"`
              : powershell
                ? `'${nativeRaw
                    .replace(/(\\*)"/g, '$1$1\\"')
                    .replace(/(\\+)$/g, "$1$1")
                    .replaceAll("'", "''")}'`
                : `'${raw.replaceAll("'", "'\\''")}'`;
          return positional.includes(key)
            ? quoted
            : `--${flagName(key)} ${quoted}`;
        })
        .join(" ")}`;
    const posix = render(false);
    const powershell = render(true);
    // PowerShell 5.1 splits whitespace inside escaped JSON quotes; JSON escapes preserve it.
    return posix === powershell
      ? posix
      : `POSIX: ${posix}\n    PowerShell 5.1: ${powershell}`;
  }
  if (!Array.isArray(schema.required) || schema.required.length === 0)
    return `forge ${words}`;
  return `forge ${words} --help --json`;
}
