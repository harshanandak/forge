import { FINGERPRINT_VERSION, reportFingerprint } from "./fingerprint.ts";
import { redactReport } from "./redact.ts";
import type { ReportInput, ReportServices } from "./types.ts";

const SUMMARY_LIMIT = 300;
const UNKNOWN = "unknown";
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const OS = /^(linux|darwin|win32|freebsd|aix|openbsd|sunos|android)$/;
const HARNESS = /^(cli|mcp)$/;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

export function recordOccurrence(
  input: ReportInput,
  services: ReportServices,
): {
  fingerprint: string;
  count: number;
  promotion: "unpromoted";
} {
  const { state, crypto } = services;
  const { labels, context } = state.host;
  const { forgeVersion = "", os = "", harness = "" } = context;
  const kind = input.kind ?? "bug";
  const redacted = redactReport(input.message, labels);
  const fingerprint = reportFingerprint(
    (value) => crypto.sha256(value),
    [UNKNOWN, UNKNOWN, kind],
    redacted,
  );
  const at = new Date(state.host.now()).toISOString();
  const previous = state.get(fingerprint);
  const times = previous?.value as
    { count: number; firstSeen: string; lastSeen: string } | undefined;
  if (
    previous &&
    (!times ||
      !Number.isSafeInteger(times.count) ||
      times.count < 1 ||
      times.count === Number.MAX_SAFE_INTEGER ||
      typeof times.firstSeen !== "string" ||
      !TIMESTAMP.test(times.firstSeen) ||
      typeof times.lastSeen !== "string" ||
      !TIMESTAMP.test(times.lastSeen) ||
      times.lastSeen < times.firstSeen)
  )
    throw new Error("Report count or timestamps are invalid");
  const count = (times?.count ?? 0) + 1;
  state.put(
    fingerprint,
    {
      v: 1,
      fingerprintVersion: FINGERPRINT_VERSION,
      fingerprint,
      kind,
      op: UNKNOWN,
      code: UNKNOWN,
      summary: Array.from(redacted).slice(0, SUMMARY_LIMIT).join(""),
      context: {
        forgeVersion: VERSION.test(forgeVersion) ? forgeVersion : UNKNOWN,
        os: OS.test(os) ? os : UNKNOWN,
        harness: HARNESS.test(harness) ? harness : UNKNOWN,
      },
      count,
      firstSeen: times?.firstSeen ?? at,
      lastSeen: times && times.lastSeen > at ? times.lastSeen : at,
    },
    { expectRevision: previous?.revision ?? 0 },
  );
  return { fingerprint, count, promotion: "unpromoted" };
}
