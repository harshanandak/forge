import { createReadStream } from "node:fs";
import { buffer } from "node:stream/consumers";
import { parseArgs } from "node:util";
import type { HubResult } from "../contract/core.ts";
import type { Person } from "../contract/domain.ts";
import { SECRET_PATTERNS } from "../contract/errors.ts";
import { ID_PATTERN } from "../contract/ids.ts";
import { LIMITS } from "../contract/mcp.ts";
import type { AdminDeps } from "../contract/runtime.ts";
import { envelope, problem } from "./responses.ts";

export function flags<T extends string>(...names: T[]) {
  return Object.fromEntries(
    names.map((name) => [name, { type: "string" }]),
  ) as Record<T, { type: "string" }>;
}

function redact(_key: string, input: unknown) {
  if (typeof input !== "string") return input;
  if (/-----(?:BEGIN|END) [A-Z ]*PRIVATE KEY-----/.test(input))
    return "[redacted]";
  let value = input;
  for (const pattern of SECRET_PATTERNS)
    value = value.replaceAll(new RegExp(pattern, "g"), "[redacted]");
  return value;
}

async function readMessage(
  file: string | undefined,
  stdin: AdminDeps["readStdin"],
) {
  const value =
    file === undefined
      ? await stdin()
      : await buffer(createReadStream(file, { end: LIMITS.bodyBytes }));
  if (Buffer.byteLength(value) > LIMITS.bodyBytes) return undefined;
  const text =
    typeof value === "string"
      ? value.replace(/\r?\n$/, "")
      : value.toString("utf8");
  return text.trim() ? text : undefined;
}

function usage(): never {
  throw new Error("invalid_invocation");
}

const idFlags = [
  "person",
  "project",
  "session",
  "to",
  "target-session",
] as const;
type StringFlag = (typeof idFlags)[number] | "ack" | "limit" | "file";
type MessageFlags = Partial<Record<StringFlag, string>> & { stdin?: boolean };

export async function messages(
  command: "inbox" | "send",
  args: string[],
  deps: AdminDeps,
) {
  const output = (result: HubResult<unknown>) => {
    const body = envelope(`hub.cli-${command}`, result);
    process.stdout.write(JSON.stringify(body, redact) + "\n");
    return result.ok ? 0 : 1;
  };
  if (!deps.config.cli.enabled) return output(problem("BLOCK_DISABLED"));
  const common = flags("person", "project", "session", "config");
  const inbox = command === "inbox";
  const sendFlags = {
    ...flags("to", "target-session", "file"),
    stdin: { type: "boolean" as const },
  };
  const values: MessageFlags = inbox
    ? parseArgs({ args, options: { ...common, ...flags("ack", "limit") } })
        .values
    : parseArgs({ args, options: { ...common, ...sendFlags } }).values;
  const { person: id, project: projectId, session: sessionId } = values;
  if (!id || !projectId) return usage();
  const invalid = (name: string) =>
    output(problem("INPUT_INVALID", "/" + name));
  for (const flag of idFlags) {
    const value = values[flag];
    if (value !== undefined && !ID_PATTERN.test(value)) return invalid(flag);
  }
  const handle = async (
    run: (person: Person) => HubResult<unknown> | Promise<HubResult<unknown>>,
  ) => {
    const person = deps.core.person(id);
    return output(person ? await run(person) : problem("PERSON_UNKNOWN"));
  };
  if (inbox) {
    const { limit: raw, ack } = values;
    if (raw !== undefined && !/^-?\d+$/.test(raw)) return usage();
    const limit = raw === undefined ? undefined : Number(raw);
    if (limit !== undefined && (limit < 1 || limit > LIMITS.inboxMax))
      return invalid("limit");
    const ackItemIds = ack?.split(",");
    if (
      ackItemIds &&
      (ackItemIds.length > LIMITS.ackMax ||
        ackItemIds.some((id) => !ID_PATTERN.test(id)))
    )
      return invalid("ack");
    return handle((person) =>
      deps.core.cliInbox(person, {
        projectId,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(limit === undefined ? {} : { limit }),
        ...(ackItemIds ? { ackItemIds } : {}),
      }),
    );
  }
  const {
    to: toPersonId,
    file,
    stdin,
    "target-session": targetSessionId,
  } = values;
  if (!sessionId || !toPersonId || Boolean(stdin) === (file !== undefined))
    return usage();
  const text = await readMessage(file, deps.readStdin).catch(() => undefined);
  if (text === undefined) return invalid("text");
  return handle((person) =>
    deps.core.cliSend(person, {
      projectId,
      sessionId,
      toPersonId,
      text,
      ...(targetSessionId === undefined ? {} : { targetSessionId }),
    }),
  );
}
