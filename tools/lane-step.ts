import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createCloneFiles } from "../src/adapters/fs/clone-files.ts";
import { nodeDeviceIdentity } from "../src/adapters/fs/device-identity.ts";
import { resolveIn } from "../src/adapters/fs/index.ts";
import { nodeProjectFiles } from "../src/adapters/fs/project-files.ts";
import { createProcessPort } from "../src/adapters/process/index.ts";
import { cloudBinding } from "../src/assembly/cloud-binding.ts";
import {
  createConfig,
  nodeConfigFiles,
  yamlConfigCodec,
} from "../src/assembly/config.ts";
import { firstPartyBlocks } from "../src/assembly/first-party.ts";
import { sessionIdentity } from "../src/assembly/identity.ts";
import { resolveOutside } from "../src/assembly/providers.ts";
import { LocalState } from "../src/assembly/state.ts";
import { boundLaneRegistry } from "../src/blocks/work/bound-lane.ts";
import workEntry from "../src/blocks/work/entry.cts";
import workConfigSchema from "../src/blocks/work/schemas/config.json" with { type: "json" };
import { validateWithSchema } from "../src/contract/schema.ts";
import { isObject } from "../src/core/config/pointer.ts";
import { validateLeaseRecord } from "../src/generated/validators.ts";
import type { StateRecord } from "../src/generated/types.ts";
import { parseInspectRequest, refuse } from "./lane-step-contract.ts";
import type {
  ConsumeResult,
  InspectRefusal,
  InspectRequest,
  InspectResult,
  LaneStepContext,
} from "./lane-step-contract.ts";
import { consumeBrief } from "./lane-step-consumer.ts";
import type { ConsumeReads, PreflightRequest } from "./lane-step-consumer.ts";

type Holder = { actor: string; session: string; device?: string | undefined };
export interface LaneRecord extends Pick<InspectRequest, "issue" | "branch"> {
  readonly worktree: string;
  readonly brief: string;
  readonly lease?: { holder: Holder; expiresAt: string };
}
type Workspace = { branch: string; head: string; status: string };
export interface InspectReads {
  readonly lane: (issue: string) => Promise<LaneRecord | undefined>;
  readonly brief: (path: string) => Promise<Uint8Array>;
  readonly workspace: (path: string) => Promise<Workspace>;
  readonly caller: () => Promise<Holder | undefined>;
  readonly now: () => number;
}

const maxBriefBytes = 262_144;
function mismatch(input: PreflightRequest, lane: LaneRecord, path: string) {
  if (lane.issue !== input.issue) return "issue";
  if (lane.worktree !== input.workspace) return "workspace";
  if (lane.branch !== input.branch) return "branch";
  if (lane.brief !== path) return "brief.path";
  return undefined;
}

export async function inspect(
  input: unknown,
  reads?: InspectReads,
): Promise<InspectResult> {
  const request = parseInspectRequest(input);
  if ("status" in request) return request;
  const result = await preflight(request, reads);
  if ("status" in result) return result;
  return { status: "context", context: result.context };
}

export function consume(
  input: unknown,
  reads?: ConsumeReads,
): Promise<ConsumeResult> {
  return consumeBrief(input, (request) => preflight(request, reads, "head"));
}

async function preflight(
  request: PreflightRequest,
  reads?: InspectReads & Partial<ConsumeReads>,
  headField: "head" | "expectedHead" = "expectedHead",
): Promise<InspectRefusal | { context: LaneStepContext; bytes: Uint8Array }> {
  const { issue, workspace, branch, brief } = request;
  const consuming = headField === "head";
  let field = "issue";
  try {
    const source = reads ?? (await localReads());
    const lane = await source.lane(issue);
    if (!lane) return refuse(field, "LANE_NOT_FOUND");
    const path = brief.path ?? lane.brief;
    const changed = mismatch(request, lane, path);
    if (changed) return refuse(changed, "CONTEXT_MISMATCH");
    field = "brief.path";
    if (!isAbsolute(path)) return refuse(field, "UNAVAILABLE");
    const raw = await source.brief(path);
    if (raw.byteLength > maxBriefBytes) return refuse(field, "UNAVAILABLE");
    const bytes = consuming ? Uint8Array.from(raw) : raw;
    const hash = createHash("sha256").update(bytes);
    const digest = `sha256:${hash.digest("hex")}`;
    if (digest !== brief.digest)
      return refuse("brief.digest", "BRIEF_DIGEST_MISMATCH");
    if (consuming) new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    field = "workspace";
    const tree = await source.workspace(workspace);
    if (tree.branch !== branch) return refuse("branch", "CONTEXT_MISMATCH");
    const head = tree.head;
    if (head !== request.expectedHead.toLowerCase())
      return refuse(headField, "CONTEXT_MISMATCH");
    if (tree.status) return refuse(field, "WORKTREE_DIRTY");
    if (consuming) {
      field = "control";
      const control = await source.control?.(issue);
      if (control !== "running")
        return refuse(
          field,
          control === "stopped" ? "LANE_STOPPED" : "UNAVAILABLE",
        );
    }
    field = "lease";
    const caller = await source.caller();
    const latest = await source.lane(issue);
    if (!latest) return refuse("issue", "LANE_NOT_FOUND");
    const moved = mismatch(request, latest, path);
    if (moved) return refuse(moved, "CONTEXT_MISMATCH");
    const lease = latest.lease;
    if (!lease) return refuse(field, "LEASE_NOT_HELD");
    if (!(Date.parse(lease.expiresAt) > source.now()))
      return refuse(field, "LEASE_EXPIRED");
    const held = lease.holder;
    const own = held.device
      ? caller?.device === held.device
      : caller?.actor === held.actor;
    if (!own || caller?.session !== held.session)
      return refuse(field, "LEASE_NOT_HELD");
    const after = consuming ? await source.workspace(workspace) : tree;
    if (after.head !== head) return refuse(headField, "CONTEXT_MISMATCH");
    if (after.branch !== branch) return refuse("branch", "CONTEXT_MISMATCH");
    if (after.status) return refuse("workspace", "WORKTREE_DIRTY");
    const context = { issue, workspace, branch, head, digest };
    return { context, bytes };
  } catch {
    return refuse(field, "UNAVAILABLE");
  }
}

const hostNames =
  /^(path|pathext|systemroot|windir|comspec|temp|tmp|tmpdir|home|userprofile)$/i;
function requireLocal(root: string) {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (cloudBinding(root, home).kind !== "unbound")
    throw new Error("Cloud lease cannot be verified offline");
}

async function localReads(): Promise<ConsumeReads> {
  const cwd = process.cwd();
  const proc = createProcessPort({
    supervision: {
      cleanupTimeoutMs: 5000,
      pollIntervalMs: 25,
      drainTimeoutMs: 250,
      maxConcurrent: 1,
    },
  });
  const env: Record<string, string> = {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
  };
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && hostNames.test(key)) env[key] = value;
  const executable = resolveOutside(proc, "git", env, cwd);
  if (executable.kind !== "resolved") throw new Error("Git unavailable");
  const git = async (cwd: string, ...args: string[]) => {
    const argv = ["-c", "core.fsmonitor=false", ...args];
    const options = { cwd, env, timeoutMs: 10_000, maxOutputBytes: 1_048_576 };
    const result = await proc.run(executable, argv, options);
    if (result.exitCode !== 0 || result.timedOut || result.truncated)
      throw new Error("Git read failed");
    return result.stdout;
  };
  async function locate(path: string) {
    const args = [
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
    ];
    const data = await git(path, "rev-parse", ...args);
    const [top, common, extra] = data.trimEnd().split(/\r?\n/);
    if (!top || !common || extra !== undefined)
      throw new Error("Bad Git paths");
    const realpath = fs.realpathSync.native;
    return [realpath(top), realpath(common)] as const;
  }
  const [root, shared] = await locate(cwd);
  const main = dirname(shared);
  if (join(main, ".git") !== shared) throw new Error("Unknown state root");
  requireLocal(root);
  const files = createCloneFiles({
    projectRoot: main,
    gitDirectory: shared,
    commonDirectory: shared,
    read: true,
    write: false,
    signal: new AbortController().signal,
  });
  const briefFiles = nodeProjectFiles(main, { strict: true });
  const filter = /^filter[.].+[.](clean|smudge|process|required)$/;
  return {
    lane(issue) {
      requireLocal(main);
      return readLane(issue, files);
    },
    brief(path) {
      const within = relative(main, path).split(sep).join("/");
      return Promise.resolve(briefFiles.read(within, maxBriefBytes));
    },
    async workspace(path) {
      const [top, common] = await locate(path);
      if (resolve(path) !== top || common !== shared)
        throw new Error("Workspace differs from registry");
      requireLocal(top);
      const index = await git(path, "ls-files", "-z", "-v", "--stage");
      if (/(?:^|\0)(?:[a-zS] |. 160000 )/.test(index))
        throw new Error("The index can hide workspace changes");
      const keys = await git(path, "config", "-z", "--name-only", "--list");
      const disabled = keys
        .split("\0")
        .filter((key) => filter.test(key))
        .flatMap(disableFilter);
      const revision = ["rev-parse", "--verify", "HEAD^{commit}"];
      const symbolic = ["rev-parse", "--symbolic-full-name", "HEAD"];
      const head = await git(path, ...revision);
      const ref = await git(path, ...symbolic);
      const flags = ["status", "--porcelain", "-uall", "--ignore-submodules"];
      const status = await git(path, ...disabled, ...flags);
      const finalHead = await git(path, ...revision);
      const finalRef = await git(path, ...symbolic);
      if (head !== finalHead || ref !== finalRef)
        throw new Error("HEAD or branch moved while reading workspace status");
      const branch = ref.startsWith("refs/heads/")
        ? ref.slice(11).trimEnd()
        : "";
      return { branch, head: head.trimEnd(), status };
    },
    caller() {
      const session = sessionIdentity(process.env, "");
      const override = process.env.FORGE_DEVICE_ID?.trim() ?? "";
      const invalid = override.length > 256 || /[\s/\\]/.test(override);
      if (!session || invalid) return Promise.resolve(undefined);
      const root = process.env.FORGE_DEVICE_ROOT ?? join(homedir(), ".forge");
      const device = override || nodeDeviceIdentity(root).read();
      return Promise.resolve({ actor: "local-cli", session, device });
    },
    async control(issue) {
      requireLocal(main);
      const work = workInstance(root);
      if (!work) return "unknown";
      if (work.enabled === false) return "stopped";
      return withState(files, (owner) =>
        owner
          ? localStop(
              owner.get(namespace, "autopilot:global"),
              storedIssue(issue),
              work.config,
            )
          : "unknown",
      );
    },
    now: Date.now,
  };
}
function disableFilter(key: string) {
  return ["-c", `${key}=${key.endsWith(".required") ? "false" : ""}`];
}
type Files = ReturnType<typeof createCloneFiles>;
const namespace = "forge/work";
const storedIssue = (issue: string) => `work-${issue.split("-").at(-1)}`;
const { localStop } = workEntry as unknown as {
  localStop: (
    record: StateRecord | undefined,
    issue: string,
    config: unknown,
  ) => "running" | "stopped";
};
function workInstance(root: string) {
  const config = createConfig({
    files: nodeConfigFiles(root),
    codec: yamlConfigCodec,
    clock: { now: Date.now },
    detect: () => [],
    builtinSource(name) {
      const builtin = `forge/${name}`;
      return Object.hasOwn(firstPartyBlocks, builtin) ? { builtin } : undefined;
    },
  }).show();
  const blocks = config.effective.blocks;
  if (!config.valid || !isObject(blocks)) return;
  const work = Object.values(blocks).filter(
    (block) =>
      isObject(block) &&
      isObject(block.source) &&
      block.source.builtin === "forge/work",
  );
  const instance = work.length === 1 ? work[0] : undefined;
  if (
    isObject(instance) &&
    !validateWithSchema(workConfigSchema, instance.config ?? {}).length
  )
    return instance;
}
async function withState<T>(
  files: Files,
  read: (owner: Awaited<ReturnType<LocalState["open"]>>) => T,
): Promise<T> {
  const path = resolveIn(files.root, ".forge/state.sqlite", "refuse");
  const state = new LocalState(path);
  try {
    return read(await state.open(false));
  } finally {
    await state.close();
  }
}
async function readLane(issue: string, files: Files) {
  const { lanes } = boundLaneRegistry(
    files as Parameters<typeof boundLaneRegistry>[0],
  );
  const matches = lanes.filter(
    (lane) => !lane.attempt && (lane.issue === issue || lane.issueId === issue),
  );
  const lane = matches.length === 1 ? matches[0] : undefined;
  if (!lane) return undefined;
  const row = { ...lane, issue };
  const subject = `issue:${storedIssue(issue)}`;
  if (lane.issueId && `issue:${lane.issueId}` !== subject) return undefined;
  return withState(files, (owner) => {
    const record = validateLeaseRecord(owner?.lease(namespace, subject));
    const item = owner?.get(namespace, subject)?.value as
      { status?: string } | undefined;
    if (item?.status !== "open" || !record.ok || record.value.releasedAt)
      return row;
    const { holder, expiresAt } = record.value;
    const actor = holder.actor.kind === "human" ? holder.actor.id : "";
    const { id: session, device } = holder.session;
    return { ...row, lease: { expiresAt, holder: { actor, session, device } } };
  });
}
function stdin(): unknown {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

if (import.meta.main) {
  const command = process.argv.length === 3 ? process.argv[2] : undefined;
  const result =
    command === "inspect"
      ? await inspect(stdin())
      : command === "consume"
        ? await consume(stdin())
        : refuse("command", "INPUT_INVALID");
  const output =
    result.status === "verified" ? { status: result.status } : result;
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = result.status === "refused" ? 2 : 0;
}
