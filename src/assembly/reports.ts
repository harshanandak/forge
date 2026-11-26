import { homedir, userInfo } from "node:os";
import { basename } from "node:path";
import type { ReportHost } from "../blocks/report/types.ts";
import type { McpCandidate } from "../contract/mcp.ts";
import type { Actor, ResultEnvelope } from "../generated/types.ts";
import { version } from "../version.ts";
import { readProjectManifest } from "./project-manifest.ts";

export const REPORT_SOURCE = { builtin: "forge/report" } as const;
export const REPORT_OP = "report.create";
export const REPORT_ACTOR: Actor = { kind: "agent", id: "forge/report" };

export function isReportFiling(entry: McpCandidate | undefined): boolean {
  return (
    entry?.builtin === true &&
    entry.blockId === REPORT_SOURCE.builtin &&
    entry.declaredOp === REPORT_OP
  );
}

export function reportHost(
  manifestRoot: string,
  scopeRoot: string | undefined,
  home: string | undefined,
  mcp: boolean,
): ReportHost {
  const labels = [basename(home || homedir())];
  if (scopeRoot !== undefined) labels.push(basename(manifestRoot));
  try {
    labels.push(userInfo().username);
  } catch {
    labels.push("");
  }
  try {
    labels.push(readProjectManifest(manifestRoot)?.name ?? "");
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

export function privateReportResult(
  op: string,
  result: ResultEnvelope,
): ResultEnvelope {
  if (result.ok) return { ...result, warnings: [] };
  const { code, retry } = result.error;
  return {
    ok: false,
    op,
    status: result.status,
    error: { code, retry, message: "Could not file a device report." },
    warnings: [],
  };
}
