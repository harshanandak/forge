import tracker from "../../../schemas/tracker.json" with { type: "json" };
import config from "./schemas/config.json" with { type: "json" };
import checkpoint from "./schemas/checkpoint.input.json" with { type: "json" };
import call from "./schemas/call.output.json" with { type: "json" };
import link from "./schemas/link.json" with { type: "json" };
import { SchemaRegistry, type SchemaObject } from "../../contract/schema.ts";
import { SCHEMA_DOCUMENTS } from "../../generated/schemas.ts";
import { isObject } from "../../core/config/pointer.ts";
import { ForgeFailure } from "../../contract/failure.ts";

type Rule = (value: Record<string, unknown>, key: string) => string | undefined;
interface Family {
  readonly key: RegExp;
  readonly schema: SchemaObject;
  readonly rules?: readonly Rule[];
}
function persisted(
  schema: SchemaObject,
  remove: string,
  extra: SchemaObject = {},
) {
  const omitted = new Set(remove.split(" "));
  return {
    ...schema,
    required: (schema.required as readonly string[]).filter(
      (name) => !omitted.has(name),
    ),
    properties: {
      ...Object.fromEntries(
        Object.entries(schema.properties as SchemaObject).filter(
          ([name]) => !omitted.has(name),
        ),
      ),
      ...extra,
    },
  };
}
const work = "work-[0-9]+";
const storedId = new RegExp(`^${work}$`);
// JavaScript's $ also matches before a final line break.
const exact = (pattern: RegExp, value: string) =>
  pattern.exec(value)?.[0] === value;
const isId = (value: unknown) =>
  typeof value === "string" && exact(storedId, value);
const identity: Rule = (value, key) =>
  isId(value.id) && value.id === key.split(":")[1]
    ? undefined
    : "WORK_VALUE_ID";
const comment = tracker.$defs.CommentInput;
const variant = (name: string, schema: SchemaObject) => ({
  ...comment,
  required: [...comment.required, name],
  properties: { ...comment.properties, [name]: schema },
});
const families: Readonly<Record<string, Family>> = {
  issue: {
    key: new RegExp(`^issue:${work}$`),
    schema: persisted(
      tracker.$defs.TrackerItem,
      "lease revision updatedAt mode slots attempts selection participants",
      {
        prefix: config.properties.idPrefix,
        closeReason: tracker.$defs.CloseInput.properties.reason,
        kind: { enum: ["task", "bug", "feature", "epic"] },
      },
    ),
    rules: [
      identity,
      (value) => {
        const references = [
          ...(value.parent === undefined ? [] : [value.parent]),
          ...(Array.isArray(value.dependsOn)
            ? (value.dependsOn as unknown[])
            : []),
        ];
        return references.every(isId) ? undefined : "WORK_VALUE_ID";
      },
    ],
  },
  comment: {
    key: new RegExp(`^comment:${work}:[1-9][0-9]*$`),
    schema: {
      oneOf: [
        comment,
        variant("call", call.properties.call),
        variant("checkpoint", persisted(checkpoint, "id")),
      ],
    },
    rules: [
      identity,
      (value) =>
        Object.hasOwn(value, "call") && Object.hasOwn(value, "checkpoint")
          ? "WORK_VALUE_COMMENT_KIND"
          : undefined,
    ],
  },
  link: {
    key: new RegExp(`^link:${work}:[1-9][0-9]*$`),
    schema: link,
    rules: [
      identity,
      (value) =>
        typeof value.url === "string" &&
        !/^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(value.url)
          ? "WORK_VALUE_URL"
          : undefined,
    ],
  },
};
const schemaId = tracker.$id.replace("tracker.json", "work-values.json");
const registry = new SchemaRegistry([
  ...SCHEMA_DOCUMENTS,
  {
    $id: schemaId,
    $defs: {
      ...tracker.$defs,
      ...Object.fromEntries(
        Object.entries(families).map(([name, row]) => [name, row.schema]),
      ),
    },
  },
]);
const validators = Object.fromEntries(
  Object.keys(families).map((name) => [
    name,
    registry.validator(`${schemaId}#/$defs/${name}`),
  ]),
);

/** Pure persisted-value admission; named reasons never include record keys or values.
 * Unknown families refuse until their reviewed row is added. Writer wiring follows in A3.
 */
export function validateWorkRecord(
  key: string,
  value: unknown,
): string | undefined {
  const name = key.split(":")[0]!;
  if (!Object.hasOwn(families, name)) return "WORK_VALUE_FAMILY";
  const family = families[name]!;
  if (!exact(family.key, key)) return "WORK_VALUE_KEY";
  if (!isObject(value)) return "WORK_VALUE_SHAPE";
  for (const rule of family.rules ?? []) {
    const reason = rule(value, key);
    if (reason) return reason;
  }
  return validators[name]!(value).ok ? undefined : "WORK_VALUE_SHAPE";
}

export function assertWorkRecord(key: string, value: unknown): void {
  const reason = validateWorkRecord(key, value);
  if (reason)
    throw new ForgeFailure({
      code: "INPUT_INVALID",
      message: reason,
      retry: "never",
    });
}
