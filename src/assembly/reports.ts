import { basename } from "node:path";
import type { ReportHost } from "../blocks/report/types.ts";
import type { Actor, ResultEnvelope } from "../generated/types.ts";
import { version } from "../version.ts";
import { readProjectManifest } from "./project-manifest.ts";

export const REPORT_SOURCE = { builtin: "forge/report" } as const;

export function canCaptureReport(
  capture: (source: typeof REPORT_SOURCE) => unknown,
): boolean {
  try {
    capture(REPORT_SOURCE);
    return true;
  } catch {
    return false;
  }
}

export function reportHost(
  checkout: string,
  paths: readonly string[],
  mcp: boolean,
): ReportHost {
  const labels = paths.map((path) => basename(path));
  try {
    labels.push(readProjectManifest(checkout)?.name ?? "");
  } catch {
    labels.push("");
  }
  return {
    labels,
    context: {
      forgeVersion: version,
      os: process.platform,
      harness: mcp ? "mcp" : "cli",
    },
    now: Date.now,
  };
}

export const REPORT_ACTOR: Actor = { kind: "agent", id: "forge/report" };

export function privateReportResult(result: ResultEnvelope): ResultEnvelope {
  if (result.ok) return result;
  const { code, retry } = result.error;
  return {
    ok: false,
    op: "report.create",
    status: result.status,
    error: { code, retry, message: "Could not file a device report." },
    warnings: [],
  };
}
