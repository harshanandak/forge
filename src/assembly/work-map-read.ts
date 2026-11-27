import { Buffer } from "node:buffer";
import { yamlConfigCodec } from "../adapters/config-yaml/index.ts";
import { normalizeFileDeclarations } from "../blocks/work/file-declarations.ts";
import {
  resolveFileOverlap,
  type GeneratedFileRule,
} from "../blocks/work/file-overlap.ts";
import workConfig from "../blocks/work/schemas/config.json" with { type: "json" };
import { validateWithSchema } from "../contract/schema.ts";
import { DEFAULT_PARSE_LIMITS } from "../contract/untrusted.ts";
import { isObject } from "../core/config/pointer.ts";
import { expandShortForm } from "../core/config/short.ts";
import { CONFIG_FILE } from "../core/config/store.ts";
import type { LeaseRecord, TrackerItem } from "../generated/types.ts";
import { validateConfigDocument } from "../generated/validators.ts";
import type { ProcessPort, SpawnOptions } from "../ports/process.ts";

export const WORK_MAP_LIMITS = {
  issues: 1000,
  linksPerIssue: 128,
  trackedPaths: 20_000,
  processes: 64,
  outputBytes: 1_048_576,
  patternWork: 64_000_000,
} as const;

type Issue = Pick<TrackerItem, "id" | "title" | "status" | "dependsOn"> &
  Pick<TrackerItem, "expectedFiles" | "actualFiles" | "filesAt"> & {
    lease?: Pick<LeaseRecord, "expiresAt" | "releasedAt">;
  };
type Page<T> = { items: readonly T[]; truncated: boolean };
type Pull = { state: "OPEN" | "CLOSED" | "MERGED"; branch?: string };
type Budget = { maxBytes: number; signal?: AbortSignal };
type ReadLimits = Budget & { limit: number };
type Read<T> = T | Promise<T>;
type Ports = {
  now(): number;
  issues(limits: ReadLimits): Read<Page<Issue>>;
  deliveries(issue: string, limits: ReadLimits): Read<Page<string>>;
  pull(url: string, limits: Budget): Read<Pull>;
  process: Pick<ProcessPort, "resolve" | "run">;
};
type Options = Pick<SpawnOptions, "cwd" | "env" | "signal" | "timeoutMs"> & {
  defaultRef: string;
  workInstance?: string;
};
type Reason = {
  kind:
    | "issues-unavailable"
    | "issues-truncated"
    | "deliveries-unavailable"
    | "deliveries-truncated"
    | "pull-unavailable"
    | "git-unavailable"
    | "policy-unreadable"
    | "tracked-paths-truncated"
    | "process-budget"
    | "output-budget"
    | "resolution-budget"
    | "undeclared"
    | "invalid-declarations"
    | "unmatched-pattern";
  issue?: string;
  source?: string;
  pattern?: string;
};
type Snapshot = {
  observedAt: string;
  defaultSha?: string;
  trackedPaths: string[];
  literalPaths: string[];
  generatedFiles: readonly GeneratedFileRule[];
  holders: {
    issue: Issue;
    leaseExpiresAt?: string;
    openPulls: (Omit<Pull, "state"> & { url: string })[];
  }[];
  complete: boolean;
  reasons: Reason[];
};

const commitSha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function generatedPolicy(text: string, instance: string) {
  const decoded = yamlConfigCodec.decode(text, DEFAULT_PARSE_LIMITS);
  if (!decoded.ok || !isObject(decoded.value))
    throw new Error("Invalid project config");
  const doc = validateConfigDocument(expandShortForm(decoded.value));
  if (!doc.ok) throw new Error("Invalid project config");
  const { blocks } = doc.value;
  const config = Object.hasOwn(blocks, instance)
    ? blocks[instance]?.config
    : undefined;
  const { generatedFiles = [] } = config ?? {};
  const rules = workConfig.properties.generatedFiles;
  if (validateWithSchema(rules, generatedFiles).length > 0)
    throw new Error("Invalid generated file policy");
  return generatedFiles as GeneratedFileRule[];
}

export async function readWorkMap(
  ports: Ports,
  options: Options,
): Promise<Snapshot> {
  const now = ports.now();
  const snapshot: Snapshot = {
    observedAt: new Date(now).toISOString(),
    trackedPaths: [],
    literalPaths: [],
    generatedFiles: [],
    holders: [],
    complete: false,
    reasons: [],
  };
  const note = (kind: Reason["kind"], detail?: Omit<Reason, "kind">) =>
    snapshot.reasons.push({ kind, ...detail });
  const { defaultRef, workInstance = "work", ...spawn } = options;
  const limits = WORK_MAP_LIMITS;
  let processes = 0;
  let authorityBytes: number = limits.outputBytes;
  const budget = (): Budget => ({
    maxBytes: authorityBytes,
    ...(spawn.signal === undefined ? {} : { signal: spawn.signal }),
  });
  function withinBytes(value: unknown, source: string): boolean {
    authorityBytes -= Buffer.byteLength(JSON.stringify(value));
    if (authorityBytes >= 0) return true;
    note("output-budget", { source });
    return false;
  }
  async function readPage<T>(
    source: "issues" | "deliveries",
    limit: number,
    read: (input: ReadLimits) => Read<Page<T>>,
    issue?: string,
  ): Promise<readonly T[]> {
    const detail = issue === undefined ? {} : { issue };
    if (authorityBytes <= 0) {
      note("output-budget", { source, ...detail });
      return [];
    }
    try {
      const page = await read({ ...budget(), limit });
      if (page.truncated || page.items.length > limit)
        note(`${source}-truncated`, detail);
      if (withinBytes(page, source)) return page.items.slice(0, limit);
    } catch {
      note(`${source}-unavailable`, detail);
    }
    return [];
  }
  async function gitText(
    source: string,
    args: readonly string[],
  ): Promise<string | undefined> {
    processes++;
    try {
      const env = { ...spawn.env, GIT_NO_LAZY_FETCH: "1" };
      const git = ports.process.resolve("git", env);
      if (git.kind !== "resolved") throw new Error("Git unavailable");
      const command = ["--no-replace-objects", ...args];
      const result = await ports.process.run(git, command, {
        ...spawn,
        env,
        maxOutputBytes: limits.outputBytes,
      });
      const bytes = Buffer.byteLength(result.stdout + result.stderr);
      if (result.truncated || bytes > limits.outputBytes) {
        note("output-budget", { source });
        return undefined;
      }
      if (
        result.exitCode !== 0 ||
        result.timedOut ||
        result.stdout.includes("\ufffd")
      )
        throw new Error("Git output unavailable");
      return result.stdout;
    } catch {
      const kind =
        source === "generated-policy" ? "policy-unreadable" : "git-unavailable";
      note(kind, { source });
      return undefined;
    }
  }
  const sha = defaultRef.startsWith("refs/remotes/")
    ? (
        await gitText("default-ref", [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${defaultRef}^{commit}`,
        ])
      )?.trim()
    : undefined;
  if (sha && commitSha.test(sha)) {
    snapshot.defaultSha = sha;
    const paths = await gitText("tracked-paths", [
      "ls-tree",
      "-rz",
      "--name-only",
      "--full-tree",
      sha,
    ]);
    if (paths?.endsWith("\0")) {
      const entries = paths.slice(0, -1).split("\0", limits.trackedPaths + 1);
      if (entries.length > limits.trackedPaths) note("tracked-paths-truncated");
      snapshot.trackedPaths = entries.slice(0, limits.trackedPaths);
    } else if (paths) note("git-unavailable", { source: "tracked-paths" });
    const config = await gitText("generated-policy", [
      "cat-file",
      "blob",
      `${sha}:${CONFIG_FILE}`,
    ]);
    if (config !== undefined) {
      try {
        snapshot.generatedFiles = generatedPolicy(config, workInstance);
      } catch {
        note("policy-unreadable");
      }
    }
  } else if (snapshot.reasons.length === 0)
    note("git-unavailable", { source: "default-ref" });

  const issues = await readPage("issues", limits.issues, (input) =>
    ports.issues(input),
  );
  const pulls = new Map<string, Pull | undefined>();
  async function lookupPull(
    url: string,
    issue: string,
  ): Promise<Pull | undefined> {
    try {
      const pull = await ports.pull(url, budget());
      if (
        pull.state !== "OPEN" &&
        pull.state !== "CLOSED" &&
        pull.state !== "MERGED"
      )
        throw new Error("Unknown pull state");
      if (withinBytes(pull, "pull")) return pull;
    } catch {
      note("pull-unavailable", { issue });
    }
    return undefined;
  }
  const literalPaths = new Set<string>();
  const wildcard = /[*?]/u;
  for (const issue of issues) {
    if (issue.status === "closed") continue;
    const declaration = normalizeFileDeclarations(issue);
    if (declaration.ok) {
      for (const path of declaration.patch.expectedFiles ?? [])
        if (!wildcard.test(path)) literalPaths.add(path);
      for (const path of declaration.patch.actualFiles ?? [])
        literalPaths.add(path);
    }

    const lease = issue.lease;
    const leaseExpiresAt =
      lease &&
      lease.releasedAt === undefined &&
      Date.parse(lease.expiresAt) > now
        ? lease.expiresAt
        : undefined;
    const openPulls: Snapshot["holders"][number]["openPulls"] = [];
    const links = await readPage(
      "deliveries",
      limits.linksPerIssue,
      (input) => ports.deliveries(issue.id, input),
      issue.id,
    );
    for (const url of new Set(links.slice(0, 1))) {
      if (!pulls.has(url)) {
        if (authorityBytes <= 0) {
          note("output-budget", { source: "pull", issue: issue.id });
          break;
        }
        if (processes >= limits.processes) {
          note("process-budget", { source: "pull", issue: issue.id });
          break;
        }
        processes++;
        pulls.set(url, await lookupPull(url, issue.id));
      }
      const { state, branch } = pulls.get(url) ?? {};
      if (state === "OPEN")
        openPulls.push(branch === undefined ? { url } : { url, branch });
    }
    if (
      leaseExpiresAt !== undefined ||
      (lease?.releasedAt === undefined && openPulls.length > 0)
    )
      snapshot.holders.push({
        issue,
        ...(leaseExpiresAt === undefined ? {} : { leaseExpiresAt }),
        openPulls,
      });
  }

  snapshot.literalPaths = [...literalPaths];
  const universe = [...new Set([...snapshot.trackedPaths, ...literalPaths])];
  const pathWork = (paths: readonly string[]) =>
    paths.reduce((total, path) => total + path.length + 1, 0);
  const universeWork = pathWork(universe);
  let patternWork: number = limits.patternWork;
  for (const { issue } of snapshot.holders) {
    const declaration = normalizeFileDeclarations(issue);
    if (!declaration.ok) {
      note("invalid-declarations", { issue: issue.id });
      continue;
    }
    const { expectedFiles } = declaration.patch;
    if (expectedFiles === undefined) {
      note("undeclared", { issue: issue.id });
      continue;
    }
    const patterns = expectedFiles.filter((path) => wildcard.test(path));
    if (patterns.length === 0) continue;
    const work = universeWork * pathWork(patterns);
    if (work > patternWork) {
      note("resolution-budget", { issue: issue.id });
      continue;
    }
    patternWork -= work;
    const resolved = resolveFileOverlap({
      left: { expectedFiles: patterns },
      right: { expectedFiles: [] },
      trackedPaths: universe,
    });
    for (const reason of resolved.reasons)
      if (reason.kind === "unmatched-pattern")
        note(reason.kind, { issue: issue.id, pattern: reason.pattern });
  }
  snapshot.complete = snapshot.reasons.every(
    (reason) => reason.kind === "pull-unavailable",
  );
  return snapshot;
}
