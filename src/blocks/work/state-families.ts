import tracker from "../../../schemas/tracker.json" with { type: "json" };
import evidence from "./schemas/attempt-evidence.input.json" with { type: "json" };
import note from "./schemas/attempt-note.input.json" with { type: "json" };
import slots from "./schemas/slots.input.json" with { type: "json" };
import record from "./schemas/lane-record.input.json" with { type: "json" };
import { SchemaRegistry, type SchemaObject } from "../../contract/schema.ts";
import { SCHEMA_DOCUMENTS } from "../../generated/schemas.ts";
import { isObject } from "../../core/config/pointer.ts";
import { allocationFloorNumber } from "../../core/state/allocation-floor.ts";
import { suffixNumber } from "../../core/state/index.ts";
import type { NamespaceFamilyPolicy } from "../../core/state/families.ts";
import { readBoundLane } from "./bound-lane-state.ts";
import {
  primaryWorkFamilies,
  validateWorkRecord,
  type Family,
} from "./validation.ts";

const object = (
  properties: SchemaObject,
  required = Object.keys(properties),
) => ({ type: "object", properties, required, additionalProperties: false });
const text = { type: "string" };
const nonempty = { ...text, minLength: 1, pattern: "\\S" };
const count = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const positive = { ...count, minimum: 1 };
const time = { $ref: "common.json#/$defs/Timestamp" };
const holder = { $ref: "state.json#/$defs/LeaseHolder" };
const id = { type: "string", pattern: "^work-[0-9]+$" };
const attempt = tracker.$defs.Attempt.properties.id;
const reason = {
  ...nonempty,
  maxLength: tracker.$defs.CommentInput.properties.body.maxLength,
};
const commit = {
  type: "string",
  pattern: "^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$",
};
const step = { enum: ["receipt", "close", "issues", "rebuild", "unwatch"] };
const omit = (properties: SchemaObject, names: readonly string[]) =>
  Object.fromEntries(
    Object.entries(properties).filter(([name]) => !names.includes(name)),
  );
const storedAttempt = object(
  {
    ...omit(tracker.$defs.Attempt.properties, [
      "live",
      "generation",
      "expiresAt",
      "evidence",
    ]),
    baseRevision: positive,
    superseded: {
      ...tracker.$defs.Attempt.properties.superseded,
      properties: {
        ...tracker.$defs.Attempt.properties.superseded.properties,
        reason,
      },
    },
  },
  tracker.$defs.Attempt.required.filter((name) => name !== "live"),
);
const numbered = (_value: Record<string, unknown>, key: string) =>
  Number.isSafeInteger(Number(key.split(":").at(-1)))
    ? undefined
    : "WORK_VALUE_KEY";
const safeAttempt = (value: unknown) => {
  try {
    return (
      typeof value === "string" && suffixNumber(value, "attempt-") !== undefined
    );
  } catch {
    return false;
  }
};
const identity = (value: Record<string, unknown>, key: string) =>
  value.id === key.split(":")[1] ? undefined : "WORK_VALUE_ID";
const attemptIdentity = (value: Record<string, unknown>, key: string) =>
  value.attempt === key.split(":")[3] && safeAttempt(value.attempt)
    ? undefined
    : "WORK_VALUE_ID";
const trimmed = (value: Record<string, unknown>) =>
  typeof value.reason === "string" && value.reason.trim() === value.reason
    ? undefined
    : "WORK_VALUE_SHAPE";
const askOption = object(
  {
    label: { type: "string", pattern: "^[A-Z]$" },
    text: nonempty,
    hold: { const: true },
    approve: { const: true },
  },
  ["label", "text"],
);
const replySource = record.properties.source;
const approval = object({
  request: record.properties.request,
  quote: record.properties.reply,
  source: replySource,
});
const ask = object(
  {
    lane: nonempty,
    issue: nonempty,
    title: text,
    reason: nonempty,
    options: { type: "array", minItems: 2, items: askOption },
    default: text,
    urgent: text,
    gated: object(
      { op: nonempty, input: { type: "object" }, request: nonempty },
      ["op", "input"],
    ),
    queuedAt: time,
    status: { enum: ["queued", "sent", "answered", "held", "done"] },
    batch: count,
    n: count,
    answer: object(
      {
        label: nonempty,
        quote: nonempty,
        source: replySource,
        at: time,
        approval,
      },
      ["label", "quote", "source", "at"],
    ),
  },
  [
    "lane",
    "issue",
    "title",
    "reason",
    "options",
    "default",
    "queuedAt",
    "status",
  ],
);
const runtimeFamilies: Record<string, Family> = {
  landing: {
    key: /^landing:work-[0-9]+:[1-9][0-9]*$/,
    schema: object({
      id,
      pr: positive,
      receipt: tracker.$defs.CloseInput.properties.receipt,
      branch: nonempty,
      worktree: nonempty,
      generation: positive,
      head: commit,
      mergeCommit: commit,
      note: tracker.$defs.CommentInput.properties.body,
    }),
    rules: [
      numbered,
      identity,
      (value, key) =>
        String(value.pr) === key.split(":")[2] ? undefined : "WORK_VALUE_ID",
    ],
  },
  reopen: {
    key: /^reopen:work-[0-9]+:[1-9][0-9]*$/,
    schema: object(
      {
        reason,
        holder,
        receipt: tracker.$defs.CloseInput.properties.receipt,
        withoutReceipt: tracker.$defs.CloseInput.properties.withoutReceipt,
        closeReason: tracker.$defs.CloseInput.properties.reason,
        claimReason: reason,
      },
      ["reason", "holder"],
    ),
    rules: [numbered, trimmed],
  },
  attempt: {
    key: /^attempt:work-[0-9]+:attempt-[1-9][0-9]*$/,
    schema: storedAttempt,
    rules: [
      (value, key) =>
        value.id === key.split(":")[2] && safeAttempt(value.id)
          ? undefined
          : "WORK_VALUE_ID",
      (value) =>
        value.superseded === undefined ||
        (isObject(value.superseded) && trimmed(value.superseded) === undefined)
          ? undefined
          : "WORK_VALUE_SHAPE",
    ],
  },
  evidence: {
    key: /^evidence:attempt:work-[0-9]+:attempt-[1-9][0-9]*:[1-9][0-9]*$/,
    schema: object(
      {
        ...omit(evidence.properties, ["id"]),
        receipt: tracker.$defs.CloseInput.properties.receipt,
        holder,
        recordedAt: time,
        attempt,
        sha: { ...evidence.properties.sha, pattern: "^[a-f0-9]{40}$" },
      },
      [
        ...evidence.required.filter((name) => name !== "id"),
        "holder",
        "recordedAt",
      ],
    ),
    rules: [numbered, attemptIdentity],
  },
  cleanup: {
    key: /^cleanup:work-[0-9]+$/,
    schema: object({ expiresAt: time }),
  },
  slots: {
    key: /^slots:work-[0-9]+$/,
    schema: object({ count: slots.properties.count, next: count }),
  },
  selection: {
    key: /^selection:work-[0-9]+$/,
    schema: object({
      mode: { enum: ["none", "single", "combine"] },
      chosen: {
        type: "array",
        items: object({ attempt, sha: { ...text, pattern: "^[a-f0-9]{40}$" } }),
      },
      reason,
      holder,
      selectedAt: time,
    }),
    rules: [
      trimmed,
      (value) => {
        const chosen = value.chosen;
        if (!Array.isArray(chosen)) return "WORK_VALUE_SHAPE";
        const n =
          value.mode === "none" ? 0 : value.mode === "single" ? 1 : undefined;
        return chosen.every(
          (item) => isObject(item) && safeAttempt(item.attempt),
        ) &&
          (n === undefined ? chosen.length > 0 : chosen.length === n) &&
          new Set(chosen.map((item) => isObject(item) && item.attempt)).size ===
            chosen.length
          ? undefined
          : "WORK_VALUE_SHAPE";
      },
    ],
  },
  allocation: {
    key: /^allocation:(?:issue:work-|(?:comment|link):work-[0-9]+:)$/,
    schema: object({ prefix: text, number: count }),
    rules: [
      (value, key) =>
        allocationFloorNumber(value, key.slice(11)) === undefined
          ? "WORK_VALUE_SHAPE"
          : undefined,
    ],
  },
  autopilot: {
    key: /^autopilot:work-[0-9]+$/,
    schema: object(
      {
        id,
        pr: positive,
        url: text,
        head: commit,
        mergeCommit: commit,
        branch: nonempty,
        named: { type: "array", items: text },
        step: { enum: [...step.enum, "done"] },
        action: object({ n: positive, step, target: text }, ["n", "step"]),
        receipt: text,
        recorded: object(
          {
            rebuild: object(
              {
                exitCode: { type: "integer" },
                argv: { type: "array", items: text },
              },
              ["exitCode"],
            ),
            unwatch: object({ done: { const: true } }),
          },
          [],
        ),
        counters: object({ actions: count, records: count }),
        rounds: object({ review: count, ci: count }, []),
      },
      [
        "id",
        "pr",
        "url",
        "head",
        "mergeCommit",
        "branch",
        "named",
        "step",
        "recorded",
        "counters",
      ],
    ),
    rules: [identity],
  },
  "autopilot-global": {
    key: /^autopilot:global$/,
    schema: object(
      {
        stopAll: time,
        stopped: { type: "object", additionalProperties: time },
        resumed: object({ at: time, scope: text, quote: text }, [
          "at",
          "scope",
        ]),
        owner: object(
          {
            channel: record.properties.ownerChannel,
            seq: count,
            sentAt: time,
            batch: object(
              {
                seq: count,
                items: { type: "array", items: nonempty },
                replied: { const: true },
              },
              ["seq", "items"],
            ),
            clarify: text,
            allOrNothing: { const: true },
          },
          ["channel"],
        ),
      },
      ["stopped"],
    ),
  },
  "autopilot-clock": {
    key: /^autopilot-clock:work-[0-9]+$/,
    schema: object({ startedAt: time }),
  },
  "autopilot-ask": {
    key: /^autopilot-ask:work-[0-9]+$/,
    schema: ask,
    rules: [
      (value) =>
        Array.isArray(value.options) &&
        value.options.some(
          (option) => isObject(option) && option.label === value.default,
        )
          ? undefined
          : "WORK_VALUE_SHAPE",
    ],
  },
  "autopilot-event": {
    key: /^autopilot-event:work-[0-9]+:[1-9][0-9]*$/,
    schema: object({ id, type: text, at: time, detail: {} }),
    rules: [numbered, identity],
  },
  "autopilot-merge": {
    key: /^autopilot-merge:work-[0-9]+$/,
    schema: object({
      head: commit,
      verdict: { enum: ["MERGE", "FIX"] },
      reviewer: {
        ...record.properties.mergeGate.properties.reviewer,
        pattern: nonempty.pattern,
      },
      at: time,
    }),
  },
  participant: {
    key: /^participant:work-[0-9]+:[1-9][0-9]*$/,
    schema: object({ holder }),
    rules: [numbered],
  },
  note: {
    key: /^note:attempt:work-[0-9]+:attempt-[1-9][0-9]*:[1-9][0-9]*$/,
    schema: object({ attempt, body: note.properties.body }),
    rules: [numbered, attemptIdentity],
  },
  "bound-lane": {
    key: /^bound-lane:\[.*\]:work-[0-9]+$/u,
    schema: { type: "object" },
    rules: [
      (value, key) => {
        try {
          const spelling = key.slice(11, key.lastIndexOf(":")),
            tuple: unknown = JSON.parse(spelling);
          if (
            !Array.isArray(tuple) ||
            tuple.length !== 3 ||
            !tuple.every(
              (part) =>
                typeof part === "string" && !/[\p{Cc}\p{Cf}]/u.test(part),
            ) ||
            JSON.stringify(tuple) !== spelling
          )
            return "WORK_VALUE_KEY";
          readBoundLane(value, key.slice(key.lastIndexOf(":") + 1));
          return undefined;
        } catch {
          return "WORK_VALUE_SHAPE";
        }
      },
    ],
  },
};
export const workFamilyDeclarations: Readonly<Record<string, Family>> =
  Object.freeze({ ...primaryWorkFamilies, ...runtimeFamilies });
const schemaId = tracker.$id.replace("tracker.json", "local-work-values.json");
const registry = new SchemaRegistry([
  ...SCHEMA_DOCUMENTS,
  {
    $id: schemaId,
    $defs: {
      ...tracker.$defs,
      ...Object.fromEntries(
        Object.entries(runtimeFamilies).map(([name, family]) => [
          name,
          family.schema,
        ]),
      ),
    },
  },
]);
const validators = Object.fromEntries(
  Object.keys(runtimeFamilies).map((name) => [
    name,
    registry.validator(`${schemaId}#/$defs/${name}`),
  ]),
);
export function validateDeclaredWorkRecord(
  key: string,
  value: unknown,
): string | undefined {
  const prefix = key.split(":")[0]!;
  if (Object.hasOwn(primaryWorkFamilies, prefix))
    return validateWorkRecord(key, value);
  const matches = Object.entries(runtimeFamilies).filter(
    ([_name, family]) => family.key.exec(key)?.[0] === key,
  );
  if (matches.length !== 1)
    return Object.hasOwn(runtimeFamilies, prefix)
      ? "WORK_VALUE_KEY"
      : "WORK_VALUE_FAMILY";
  const [name, family] = matches[0]!;
  if (!isObject(value)) return "WORK_VALUE_SHAPE";
  for (const rule of family.rules ?? []) {
    const reason = rule(value, key);
    if (reason) return reason;
  }
  return validators[name]!(value).ok ? undefined : "WORK_VALUE_SHAPE";
}
export const workFamilyPolicy: NamespaceFamilyPolicy = {
  namespace: "forge/work",
  families: Object.fromEntries(
    Object.entries(workFamilyDeclarations).map(([name, family]) => [
      name,
      { key: family.key, admit: validateDeclaredWorkRecord },
    ]),
  ),
};
