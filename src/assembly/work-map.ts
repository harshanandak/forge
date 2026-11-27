import { resolveFileOverlap } from "../blocks/work/file-overlap.ts";
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
const incompleteCode = "WORK_FILE_MAP_INCOMPLETE";

const incomplete = (reason: string): Warning => ({
  code: incompleteCode,
  message: `File overlap map incomplete (${reason}). Some overlap may be missing.`,
});

function quoted(text: string, limit: number): string {
  const escaped = escapeDisplayText(text, "fragment");
  if (escaped.length + 2 <= limit) return `"${escaped}"`;
  const prefix = escaped.slice(0, limit - 3).replace(/[\uD800-\uDBFF]$/u, "");
  return `"${prefix}…"`;
}

function warningTail(candidate: Issue, holder: Holder, branchFor?: Branch) {
  const other = holder.issue;
  const pull =
    holder.openPulls.find(({ branch }) => branch) ?? holder.openPulls[0];
  const branch = pull?.branch ?? branchFor?.(other.id);
  const evidence = pull
    ? `open PR ${quoted(pull.url, 240)}`
    : `lease until ${holder.leaseExpiresAt}`;
  const [first, second] = other.dependsOn.includes(candidate.id)
    ? [candidate.id, other.id]
    : [other.id, candidate.id];
  const lane = branch ? ` on ${quoted(branch, 180)}` : "";
  const who = `${other.id} ${quoted(other.title, 180)}${lane}`;
  return ` overlaps ${who} (${evidence}). Finish ${first} first, then start ${second}.`;
}

function scanWarnings(snapshot: Snapshot, branchFor?: Branch): Scan {
  const warnings: Warning[] = [];
  let omitted = 0;
  const reasons = new Set<string>(snapshot.reasons.map(({ kind }) => kind));
  const candidate = snapshot.candidate;
  if (!candidate) reasons.add("candidate unavailable");
  const paths = [...snapshot.trackedPaths, ...snapshot.literalPaths];
  const length = (paths: readonly string[]) =>
    paths.reduce((sum, path) => sum + path.length + 1, 0);
  const pathWork = length(paths);
  const generatedWork = length(snapshot.generatedFiles.map(({ glob }) => glob));
  let remaining: number = WORK_MAP_LIMITS.patternWork;
  for (const holder of snapshot.holders) {
    const other = holder.issue;
    if (!candidate || other.id !== candidate.id) continue;
    const declarations = [
      ...(candidate.expectedFiles ?? []),
      ...(other.expectedFiles ?? []),
    ];
    const globWork = length(declarations.filter((path) => /[*?]/u.test(path)));
    const universeWork = globWork ? pathWork : 0;
    const declarationWork =
      length(declarations) +
      length(candidate.actualFiles ?? []) +
      length(other.actualFiles ?? []);
    remaining -=
      universeWork * globWork +
      (universeWork + declarationWork) * (1 + generatedWork);
    if (remaining < 0) {
      reasons.add("resolution-budget");
      break;
    }
    const result = resolveFileOverlap({
      left: candidate,
      right: other,
      trackedPaths: globWork ? paths : [],
      generatedFiles: snapshot.generatedFiles,
    });
    for (const reason of result.reasons) reasons.add(reason.kind);
    if (!result.overlaps.length) continue;
    const tail = warningTail(candidate, holder, branchFor);
    for (const { path } of result.overlaps) {
      if (warnings.length < maxWarnings)
        warnings.push({
          code: "WORK_FILE_OVERLAP",
          message: quoted(path, maxMessage - tail.length) + tail,
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
