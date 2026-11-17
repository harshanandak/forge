import tracker from "../../../schemas/tracker.json" with { type: "json" };
import evidence from "./schemas/attempt-evidence.input.json" with { type: "json" };
import note from "./schemas/attempt-note.input.json" with { type: "json" };
import slots from "./schemas/slots.input.json" with { type: "json" };
import record from "./schemas/lane-record.input.json" with { type: "json" };
import {
  SchemaRegistry,
  jsonEqual,
  type SchemaObject,
} from "../../contract/schema.ts";
import { SCHEMA_DOCUMENTS } from "../../generated/schemas.ts";
import { isObject } from "../../core/config/pointer.ts";
import { allocationFloorNumber } from "../../core/state/allocation-floor.ts";
import { suffixNumber } from "../../core/state/index.ts";
import type { NamespaceFamilyPolicy } from "../../core/state/families.ts";
import { readBoundLane } from "./bound-lane-state.ts";
import * as primitives from "./record-primitives.ts";
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
const id = { type: "string", pattern: "^work-[0-9]+(?![\\s\\S])" };
const attempt = tracker.$defs.Attempt.properties.id;
const reason = {
  ...nonempty,
  maxLength: tracker.$defs.CommentInput.properties.body.maxLength,
};
const commit = record.properties.mergeGate.properties.head;
const step = { enum: ["receipt", "close", "issues", "rebuild", "unwatch"] };
const omit = (properties: SchemaObject, names: readonly string[]) =>
  Object.fromEntries(
    Object.entries(properties).filter(([name]) => !names.includes(name)),
  );
const storedAttempt = object(
  {
    ...omit(
      tracker.$defs.Attempt.properties,
      "live generation expiresAt evidence".split(" "),
    ),
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
const positiveSuffix = (value: string, prefix: string) => {
  try {
    return suffixNumber(value, prefix) !== undefined;
  } catch {
    return false;
  }
};
const numbered = (_value: Record<string, unknown>, key: string) =>
  positiveSuffix(key, key.slice(0, key.lastIndexOf(":") + 1))
    ? undefined
    : "WORK_VALUE_KEY";
const safeAttempt = (value: unknown) =>
  typeof value === "string" && positiveSuffix(value, "attempt-");
const identity = (value: Record<string, unknown>, key: string) =>
  value.id === key.split(":")[1] ? undefined : "WORK_VALUE_ID";
const attemptIdentity = (value: Record<string, unknown>, key: string) =>
  value.attempt === key.split(":")[3] && safeAttempt(value.attempt)
    ? undefined
    : "WORK_VALUE_ID";
const trimmed = (value: Record<string, unknown>) =>
  primitives.validReason(value.reason) ? undefined : "WORK_VALUE_SHAPE";
const askOption = object(
  {
    label: { type: "string", pattern: "^[A-Z]$" },
    text: nonempty,
    hold: { const: true },
    approve: { const: true },
  },
  ["label", "text"],
);
const nonblankFields = (schema: SchemaObject) => ({
  allOf: [schema, { additionalProperties: nonempty }],
});
const replySource = nonblankFields(record.properties.source);
const request = record.properties.request;
const approval = object({
  request,
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
    gated: object({ op: nonempty, input: { type: "object" }, request }, [
      "op",
      "input",
    ]),
    queuedAt: time,
    status: { enum: ["queued", "sent", "answered", "held", "done"] },
    batch: count,
    n: count,
    answer: object(
      {
        label: nonempty,
        quote: record.properties.reply,
        source: replySource,
        at: time,
        approval,
      },
      ["label", "quote", "source", "at"],
    ),
  },
  "lane issue title reason options default queuedAt status".split(" "),
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
    rules: [
      numbered,
      trimmed,
      (value) =>
        value.claimReason === undefined ||
        primitives.validReason(value.claimReason)
          ? undefined
          : "WORK_VALUE_SHAPE",
    ],
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
        sha: evidence.properties.sha,
      },
      [
        ...evidence.required.filter((name) => name !== "id"),
        "holder",
        "recordedAt",
      ],
    ),
    rules: [
      numbered,
      attemptIdentity,
      (value) =>
        primitives.evidenceProblem({
          sha: value.sha,
          metrics: value.metrics,
        }) || primitives.normalizedEvidenceSha(value.sha) !== value.sha
          ? "WORK_VALUE_SHAPE"
          : undefined,
    ],
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
        items: object({ attempt, sha: evidence.properties.sha }),
      },
      reason,
      holder,
      selectedAt: time,
    }),
    rules: [
      trimmed,
      (value) => {
        const chosen = value.chosen as { attempt: string; sha: string }[];
        const size = chosen.length;
        const expected = value.mode === "none" ? 0 : 1;
        return (value.mode === "combine" ? size > 0 : size === expected) &&
          new Set(chosen.map((item) => item.attempt)).size === size &&
          chosen.every(
            (item) =>
              safeAttempt(item.attempt) &&
              primitives.normalizedEvidenceSha(item.sha) === item.sha,
          )
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
        named: { type: "array", items: id },
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
      "id pr url head mergeCommit branch named step recorded counters".split(
        " ",
      ),
    ),
    rules: [
      (value, key) =>
        typeof value.id === "string" && primitives.journalKey(value.id) === key
          ? undefined
          : "WORK_VALUE_ID",
      (value) =>
        value.receipt === undefined || primitives.validReceipt(value.receipt)
          ? undefined
          : "WORK_VALUE_SHAPE",
    ],
  },
  "autopilot-global": {
    key: /^autopilot:global$/,
    schema: object(
      {
        stopAll: time,
        stopped: { type: "object", additionalProperties: time },
        resumed: object(
          { at: time, scope: text, quote: text },
          "at scope".split(" "),
        ),
        owner: object(
          {
            channel: nonblankFields(record.properties.ownerChannel),
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
    rules: [
      (value) => {
        const quote = (value.resumed as { quote?: string } | undefined)?.quote;
        return quote === undefined ||
          quote.length <= record.properties.reply.maxLength
          ? undefined
          : "WORK_VALUE_SHAPE";
      },
    ],
  },
  "autopilot-clock": {
    key: /^autopilot-clock:work-[0-9]+$/,
    schema: object({ startedAt: time }),
  },
  "autopilot-ask": {
    key: /^autopilot-ask:work-[0-9]+$/,
    schema: ask,
    rules: [
      (value, key) => {
        if (primitives.ASK(value.lane as string) !== key)
          return "WORK_VALUE_KEY";
        const options = value.options as Record<string, unknown>[];
        if (!options.some((option) => option.label === value.default))
          return "WORK_VALUE_SHAPE";
        const answer = value.answer as Record<string, unknown> | undefined;
        if (!answer)
          return value.status === "answered" || value.status === "held"
            ? "WORK_VALUE_SHAPE"
            : undefined;
        const option = options.find((option) => option.label === answer.label);
        const gate = value.gated as { request?: string } | undefined;
        const quote = answer.quote as string;
        return option &&
          quote === quote.trim() &&
          quote.length <= record.properties.reply.maxLength &&
          (value.status === "done" ||
            value.status === (option.hold ? "held" : "answered")) &&
          jsonEqual(
            answer.approval,
            primitives.approvalFor(
              option.approve === true,
              gate?.request,
              quote,
              answer.source,
            ),
          )
          ? undefined
          : "WORK_VALUE_SHAPE";
      },
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
      reviewer: record.properties.mergeGate.properties.reviewer,
      at: time,
    }),
    rules: [
      (value) =>
        primitives.validReason(value.reviewer) &&
        primitives.validReceipt(value.reviewer)
          ? undefined
          : "WORK_VALUE_SHAPE",
    ],
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
    key: primitives.boundLanePattern,
    schema: { type: "object" },
    rules: [
      (value, key) => {
        const project = primitives.readBoundLaneKey(key);
        if (!project) return "WORK_VALUE_KEY";
        try {
          readBoundLane(value, project.id);
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
        Object.entries(runtimeFamilies).map(([name, { schema }]) => [
          name,
          schema,
        ]),
      ),
    },
  },
]);
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
  if (
    !isObject(value) ||
    registry.validate(`${schemaId}#/$defs/${name}`, value).length
  )
    return "WORK_VALUE_SHAPE";
  for (const rule of family.rules ?? []) {
    const reason = rule(value, key);
    if (reason) return reason;
  }
  return undefined;
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
