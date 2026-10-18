import { createHash } from "node:crypto";
import { validateWithSchema } from "../../contract/schema.ts";
import type { CheckReceipt } from "./types.ts";
import schema from "./schemas/receipt.json" with { type: "json" };

/** Sorted records make bindings independent of object insertion order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Receipt input must be JSON");
  return encoded;
}
export function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}
export function verifyReceipt(
  value: unknown,
  expectedInputsDigest: string,
): value is CheckReceipt {
  if (
    typeof value !== "object" ||
    value === null ||
    validateWithSchema(schema, value).length > 0
  )
    return false;
  const { digest, ...body } = value as Record<string, unknown>;
  const receipt = value as CheckReceipt;
  if (
    receipt.checked.length !== receipt.runs.length ||
    receipt.checked.some(
      (checked, index) =>
        checked.name !== receipt.runs[index]?.name ||
        checked.status !== receipt.runs[index]?.status,
    )
  )
    return false;
  if (
    receipt.status === "PASS" &&
    (receipt.runs.length === 0 ||
      receipt.runs.some(
        (run) =>
          run.status !== "PASS" ||
          run.exitCode !== 0 ||
          run.timedOut ||
          run.truncated ||
          run.signal !== null ||
          run.testCount === 0,
      ))
  )
    return false;
  return (
    body.version === 1 &&
    body.inputsDigest === expectedInputsDigest &&
    typeof digest === "string" &&
    digest === hash(body)
  );
}
