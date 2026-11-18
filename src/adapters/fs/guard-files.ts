import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { createOutputGate, MAX_BYTES } from "./secret-output.ts";

const FILE_MAX_BYTES = 1024 * 1024;
interface OutputDecision {
  readonly decision?: "block";
  readonly reason?: string;
}
interface Inspection {
  readonly ok: true;
  readonly bytes: number;
  readonly modifiedAt: string;
  readonly rawContentReturned: false;
  readonly jsonValid?: boolean;
  readonly redactionMarkers?: number;
}
const feedback = () => ({
  decision: "block" as const,
  reason:
    "Credential safety check withheld this tool result. Use a protected operation or metadata-only inspection; do not repeat a raw dump.",
});

function canonical(text: string, depth = 0): string {
  if (depth > 40) throw new Error("Output nesting limit");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (
    typeof parsed !== "string" &&
    (parsed === null || typeof parsed !== "object")
  )
    return text;
  const visit = (value: unknown, level: number): unknown => {
    if (level > 40) throw new Error("Output nesting limit");
    if (typeof value === "string") return canonical(value, level + 1);
    if (Array.isArray(value))
      return value.map((item) => visit(item, level + 1));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          canonical(key, level + 1),
          visit(item, level + 1),
        ]),
      );
    return value;
  };
  return JSON.stringify(
    typeof parsed === "string"
      ? canonical(parsed, depth + 1)
      : visit(parsed, depth + 1),
  );
}

function parseDotEnv(text: string): string[] {
  if (typeof text !== "string" || Buffer.byteLength(text) > FILE_MAX_BYTES)
    throw new Error("Credential registry unavailable");
  const found: string[] = [];
  const seen = new Set();
  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = rawLine.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match || seen.has(match[1]!))
      throw new Error("Credential registry unavailable");
    seen.add(match[1]!);
    let value = match[2]!.trim();
    if (value.startsWith("'")) {
      const end = value.indexOf("'", 1);
      if (end < 0 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1)))
        throw new Error("Credential registry unavailable");
      value = value.slice(1, end);
    } else if (value.startsWith('"')) {
      let parsed = "";
      let end = -1;
      for (let index = 1; index < value.length; index += 1) {
        const character = value[index];
        if (character === '"') {
          end = index;
          break;
        }
        if (character !== "\\") {
          parsed += character;
          continue;
        }
        index += 1;
        const escaped = value[index];
        const replacements: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (!Object.prototype.hasOwnProperty.call(replacements, escaped ?? ""))
          throw new Error("Credential registry unavailable");
        parsed += replacements[escaped!]!;
      }
      if (end < 0 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1)))
        throw new Error("Credential registry unavailable");
      value = parsed;
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
      if (/\0/.test(value)) throw new Error("Credential registry unavailable");
    }
    found.push(value);
  }
  return found;
}

function openFile(file: string): number {
  return openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
}

function boundedRead(descriptor: number, size: number, limit: number): string {
  if (size > limit) throw new Error("Inspection size limit");
  const buffer = Buffer.alloc(size + 1);
  let bytes = 0;
  while (bytes < buffer.length) {
    const read = readSync(
      descriptor,
      buffer,
      bytes,
      buffer.length - bytes,
      bytes,
    );
    if (!read) break;
    bytes += read;
  }
  if (bytes > size) throw new Error("File changed during inspection");
  return buffer.subarray(0, bytes).toString("utf8");
}

function registeredValues(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const values = Object.entries(env)
    .filter(([name]) =>
      /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|DATABASE_URL|DSN|AUTHORIZATION/i.test(
        name,
      ),
    )
    .map(([, value]) => value)
    .filter((value): value is string => typeof value === "string");
  let descriptor: number;
  try {
    descriptor = openFile(join(home, ".agent-secrets", ".env"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return values;
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("Credential registry unavailable");
    return values.concat(
      parseDotEnv(boundedRead(descriptor, stat.size, FILE_MAX_BYTES)),
    );
  } finally {
    closeSync(descriptor);
  }
}

export function checkOutput(
  input: unknown,
  values: readonly unknown[],
): OutputDecision {
  try {
    if (
      !input ||
      typeof input !== "object" ||
      !("hook_event_name" in input) ||
      input.hook_event_name !== "PostToolUse" ||
      !Object.hasOwn(input, "tool_response")
    )
      return feedback();
    const text = JSON.stringify(
      (input as Record<string, unknown>).tool_response,
    );
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BYTES)
      return feedback();
    return createOutputGate(values)(text) === canonical(text) ? {} : feedback();
  } catch {
    return feedback();
  }
}

export function checkRegisteredOutput(
  input: unknown,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): OutputDecision {
  try {
    const values = registeredValues(home, env);
    if (
      input &&
      typeof input === "object" &&
      "hook_event_name" in input &&
      input.hook_event_name === "PostToolBatch"
    ) {
      if (!("tool_calls" in input) || !Array.isArray(input.tool_calls))
        return feedback();
      for (const call of input.tool_calls as unknown[]) {
        if (
          !call ||
          typeof call !== "object" ||
          !("tool_response" in call) ||
          checkOutput(
            {
              hook_event_name: "PostToolUse",
              tool_response: call.tool_response,
            },
            values,
          ).decision
        )
          return feedback();
      }
      return {};
    }
    return checkOutput(input, values);
  } catch {
    return feedback();
  }
}

export function inspectFile(
  mode: "metadata" | "summary",
  file: string,
): Inspection {
  if (typeof file !== "string" || !file || /[\r\n\0]/.test(file))
    throw new Error("Invalid inspection request");
  const descriptor = openFile(file);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("File inspection required");
    const result: Inspection = {
      ok: true,
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      rawContentReturned: false,
    };
    if (mode === "metadata") return result;
    const text = boundedRead(descriptor, stat.size, MAX_BYTES);
    let jsonValid = false;
    try {
      JSON.parse(text.replace(/^﻿/, ""));
      jsonValid = true;
    } catch {
      jsonValid = false;
    }
    const checked = createOutputGate()(text);
    return {
      ...result,
      jsonValid,
      redactionMarkers: (checked.match(/\[REDACTED\]/g) ?? []).length,
    };
  } finally {
    closeSync(descriptor);
  }
}
