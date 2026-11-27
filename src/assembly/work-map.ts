import { resolveFileOverlap } from "../blocks/work/file-overlap.ts";
import { normalizeFileDeclarations } from "../blocks/work/file-declarations.ts";
import { escapeDisplayText } from "../contract/display-text.ts";
import type { ResultEnvelope } from "../generated/types.ts";
import { readWorkMap, WORK_MAP_LIMITS } from "./work-map-read.ts";

type Snapshot = Awaited<ReturnType<typeof readWorkMap>>;
type Holder = Snapshot["holders"][number];
type Issue = Holder["issue"];
type Warning = ResultEnvelope["warnings"][number];
type Scan = { warnings: Warning[]; omitted: number };
type Branch = (id: string) => string | undefined;
const maxWarnings = 32;
const maxMessage = 2000;
const maxIssueId = 200;
const incompleteCode = "WORK_FILE_MAP_INCOMPLETE";

const incomplete = (reason: string): Warning => ({
  code: incompleteCode,
  message: `File overlap map incomplete (${reason}). Some overlap may be missing.`,
});

function clipped(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const prefix = text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/u, "");
  return `${prefix}…`;
}

function quoted(text: string, limit: number): string {
  return `"${clipped(escapeDisplayText(text, "fragment"), limit - 2)}"`;
}

function dependentsOf(candidateId: string, graph: Snapshot["dependencies"]) {
  const dependents = new Map<string, string[]>();
  for (const [id, prerequisites] of graph ?? []) {
    if (!Array.isArray(prerequisites)) continue;
    for (const prerequisite of prerequisites) {
      if (typeof prerequisite !== "string") continue;
      const direct = dependents.get(prerequisite);
      if (direct) direct.push(id);
      else dependents.set(prerequisite, [id]);
    }
  }
  const pending = [candidateId];
  const seen = new Set(pending);
  for (const id of pending) {
    for (const next of dependents.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(next);
    }
  }
  return seen;
}

function warningTail(
  candidate: Issue,
  holder: Holder,
  candidateFirst: boolean,
  branchFor?: Branch,
) {
  const other = holder.issue;
  const pull =
    holder.openPulls.find(({ branch }) => branch) ?? holder.openPulls[0];
  const branch = pull?.branch ?? branchFor?.(other.id);
  const evidence = pull
    ? `open PR ${quoted(pull.url, 240)}`
    : `lease until ${clipped(escapeDisplayText(holder.leaseExpiresAt ?? "", "fragment"), 240)}`;
  const incumbentId = clipped(
    escapeDisplayText(other.id, "fragment"),
    maxIssueId,
  );
  const candidateId = clipped(
    escapeDisplayText(candidate.id, "fragment"),
    maxIssueId,
  );
  const [first, second] = candidateFirst
    ? [candidateId, incumbentId]
    : [incumbentId, candidateId];
  const lane = branch ? ` on ${quoted(branch, 180)}` : "";
  const who = `${incumbentId} ${quoted(other.title, 180)}${lane}`;
  return ` overlaps ${who} (${evidence}). Finish ${first} first, then start ${second}.`;
}

function scanWarnings(snapshot: Snapshot, branchFor?: Branch): Scan {
  const warnings: Warning[] = [];
  let omitted = 0;
  const reasons = new Set<string>(snapshot.reasons.map(({ kind }) => kind));
  const candidate = snapshot.candidate;
  const left = candidate && normalizeFileDeclarations(candidate);
  if (!candidate || !left?.ok) {
    reasons.add(candidate ? "invalid-declarations" : "candidate unavailable");
    return { warnings: [incomplete([...reasons].join(", "))], omitted };
  }
  const dependents = dependentsOf(candidate.id, snapshot.dependencies);
  if (candidate.id.length > maxIssueId) reasons.add("invalid-issue-id");
  const paths = [...snapshot.trackedPaths, ...snapshot.literalPaths];
  const length = (paths: readonly string[]) =>
    paths.reduce((sum, path) => sum + path.length + 1, 0);
  const pathWork = length(paths);
  const generatedWork = length(snapshot.generatedFiles.map(({ glob }) => glob));
  let remaining: number = WORK_MAP_LIMITS.patternWork;
  for (const holder of snapshot.holders) {
    const other = holder.issue;
    if (other.id === candidate.id) continue;
    if (other.id.length > maxIssueId) reasons.add("invalid-issue-id");
    const right = normalizeFileDeclarations(other);
    if (!right.ok) {
      reasons.add("invalid-declarations");
      continue;
    }
    const declarations = [
      ...(left.patch.expectedFiles ?? []),
      ...(right.patch.expectedFiles ?? []),
    ];
    const globWork = length(declarations.filter((path) => /[*?]/u.test(path)));
    const universeWork = globWork ? pathWork : 0;
    const declarationWork =
      length(declarations) +
      length(left.patch.actualFiles ?? []) +
      length(right.patch.actualFiles ?? []);
    remaining -=
      universeWork * globWork +
      (universeWork + declarationWork) * (1 + generatedWork);
    if (remaining < 0) {
      reasons.add("resolution-budget");
      break;
    }
    const result = resolveFileOverlap({
      left: left.patch,
      right: right.patch,
      trackedPaths: globWork ? paths : [],
      generatedFiles: snapshot.generatedFiles,
    });
    for (const reason of result.reasons) reasons.add(reason.kind);
    if (!result.overlaps.length) continue;
    const tail = warningTail(
      candidate,
      holder,
      dependents.has(other.id),
      branchFor,
    );
    for (const { path } of result.overlaps) {
      if (warnings.length < maxWarnings)
        warnings.push({
          code: "WORK_FILE_OVERLAP",
          message: clipped(
            quoted(path, Math.max(3, maxMessage - tail.length)) + tail,
            maxMessage,
          ),
        });
      else omitted++;
    }
  }
  if (reasons.size) warnings.unshift(incomplete([...reasons].join(", ")));
  return { warnings, omitted };
}

export function appendWorkMapWarnings(
  existing: readonly Warning[],
  scan: Scan,
): Warning[] {
  const all = [...existing, ...scan.warnings];
  if (!scan.omitted && all.length <= maxWarnings) return all;
  const prioritized = all.filter(({ code }) => code === incompleteCode);
  const rest = all.filter(({ code }) => code !== incompleteCode);
  const omitted = scan.omitted + all.length - (maxWarnings - 1);
  return [
    ...[...prioritized, ...rest].slice(0, maxWarnings - 1),
    {
      code: "WORK_FILE_MAP_TRUNCATED",
      message: `${omitted} warning rows omitted at the envelope limit.`,
    },
  ];
}

export async function readWorkWarnings(
  ports: Parameters<typeof readWorkMap>[0],
  options: Parameters<typeof readWorkMap>[1] & { candidateId: string },
  branchFor?: Branch,
): Promise<Scan> {
  try {
    return scanWarnings(await readWorkMap(ports, options), branchFor);
  } catch {
    return { warnings: [incomplete("read unavailable")], omitted: 0 };
  }
}
