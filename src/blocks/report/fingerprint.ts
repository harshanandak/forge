import type { ReportKind } from "./types.ts";

export const FINGERPRINT_VERSION = "fp1";

export function reportFingerprint(
  sha256: (value: string) => string,
  op: string,
  code: string,
  kind: ReportKind,
  redacted: string,
): string {
  const normalized = redacted
    .replace(/\b[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\b/gi, "[redacted]")
    .replace(/\b[a-z][\w-]*-\d+\b/gi, "[redacted]")
    .replace(/\p{Nd}+(?:[.,]\p{Nd}+)*/gu, "[redacted]");
  return (
    FINGERPRINT_VERSION +
    ":" +
    sha256(JSON.stringify([FINGERPRINT_VERSION, op, code, kind, normalized]))
  );
}
