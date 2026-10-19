import type { ProcessPort } from "../../ports/process.ts";
import type { LeaseStateClient } from "../../assembly/state-client.ts";

declare const fail: (code: string, message: string) => never;
type Json = Record<string, unknown>;
interface Call {
  readonly input: Json;
  readonly config?: unknown;
  readonly services?: unknown;
  readonly signal: AbortSignal;
  readonly deadline: number;
}
interface Config {
  readonly envNames: readonly string[];
  readonly provider: {
    readonly executable: string;
    readonly readArgs: readonly string[];
    readonly writeArgs: readonly string[];
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
  };
  readonly minApprovals: number;
  readonly settleMs: number;
  readonly optionalChecks: "ignore" | "safe-terminal";
  readonly allowNoChecks: boolean;
  readonly blockingLabels: readonly string[];
  readonly leaseMs: number;
  readonly squashTitle: string;
  readonly squashBody: string;
}
interface Services {
  readonly state: LeaseStateClient;
  readonly process: ProcessPort & { readonly cwd: string };
  readonly environment: {
    select(names: readonly string[]): Readonly<Record<string, string>>;
  };
  readonly identity?: { readonly env: Readonly<Record<string, string>> };
}
interface Ref {
  readonly repository: string;
  readonly number: number;
}
interface Check {
  readonly name: string;
  readonly appId: number | null;
  readonly headSha: string;
  readonly status: string;
  readonly conclusion: string | null;
}
interface Review {
  readonly id: string;
  readonly author: string | null;
  readonly state: string;
  readonly headSha: string;
  readonly updatedAt: number;
  readonly authorizing: boolean;
}
interface Thread {
  readonly headSha: string;
  readonly id: string;
  readonly resolved: boolean;
}
interface Finding {
  readonly headSha: string;
  readonly label: string;
  readonly resolved: boolean;
}
interface Protection {
  readonly headSha: string;
  readonly baseSha: string;
  readonly strictStatusChecks: boolean;
  readonly atomicBaseCondition: boolean;
  readonly baseComparison: {
    readonly headSha: string;
    readonly baseSha: string;
    readonly behindBy: number;
  } | null;
}
interface Evidence extends Ref {
  readonly protection: Protection;
  readonly headSha: string;
  readonly baseSha: string;
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly draft: boolean;
  readonly mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  readonly mergeableHeadSha: string;
  readonly complete: boolean;
  readonly checks: readonly Check[];
  readonly requiredChecks: readonly {
    readonly name: string;
    readonly appId: number | null;
  }[];
  readonly reviews: readonly Review[];
  readonly threads: readonly Thread[];
  readonly findings: readonly Finding[];
  readonly lastActivityAt: number;
}
type Status =
  | "INCOMPLETE"
  | "DRAFT"
  | "CONFLICTING"
  | "CHECKS_FAILED"
  | "CHECKS_PENDING"
  | "REVIEW_BLOCKED"
  | "REVIEW_REQUIRED"
  | "SETTLING"
  | "MERGE_READY"
  | "CLOSED"
  | "MERGED";
function object(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireObject(value: unknown): Json {
  if (!object(value)) fail("INPUT_INVALID", "Expected an object");
  return value;
}
function string(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function enumValue(value: unknown, values: readonly string[]): value is string {
  return typeof value === "string" && values.includes(value);
}
function sha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
}
function ref(value: Json): Ref {
  if (
    typeof value.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository) ||
    !Number.isSafeInteger(value.number) ||
    Number(value.number) <= 0
  )
    fail(
      "INPUT_INVALID",
      "An explicit repository and positive pull request number are required",
    );
  return {
    repository: value.repository.toLowerCase(),
    number: Number(value.number),
  };
}
function config(value: unknown): Config {
  const c = requireObject(value),
    p = requireObject(c.provider);
  if (
    !Array.isArray(c.envNames) ||
    c.envNames.length > 256 ||
    !c.envNames.every(
      (v: unknown) =>
        typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(v),
    )
  )
    fail("INPUT_INVALID", "Explicit bounded environment names are required");
  if (
    !string(p.executable) ||
    !Array.isArray(p.readArgs) ||
    !p.readArgs.every((v: unknown) => typeof v === "string") ||
    !Array.isArray(p.writeArgs) ||
    !p.writeArgs.every((v: unknown) => typeof v === "string")
  )
    fail(
      "INPUT_INVALID",
      "Provider executable, read argv and write argv must be explicit",
    );
  for (const [key, low, high] of [
    ["timeoutMs", 1, 300_000],
    ["maxOutputBytes", 1024, 1_048_576],
  ] as const)
    if (
      !Number.isSafeInteger(p[key]) ||
      Number(p[key]) < low ||
      Number(p[key]) > high
    )
      fail("INPUT_INVALID", `Invalid provider ${key}`);
  for (const [key, low, high] of [
    ["minApprovals", 0, 100],
    ["settleMs", 0, 86_400_000],
    ["leaseMs", 1000, 86_400_000],
  ] as const)
    if (
      !Number.isSafeInteger(c[key]) ||
      Number(c[key]) < low ||
      Number(c[key]) > high
    )
      fail("INPUT_INVALID", `Invalid ${key}`);
  if (
    typeof c.allowNoChecks !== "boolean" ||
    !enumValue(c.optionalChecks, ["ignore", "safe-terminal"]) ||
    !Array.isArray(c.blockingLabels) ||
    c.blockingLabels.length > 100 ||
    !c.blockingLabels.every((v: unknown) => string(v)) ||
    typeof c.squashTitle !== "string" ||
    typeof c.squashBody !== "string"
  )
    fail(
      "INPUT_INVALID",
      "Approval, optional check, finding and squash policies must be configured",
    );
  return value as Config;
}
function services(value: unknown): Services {
  const s = requireObject(value);
  if (
    !string((s.process as Json | undefined)?.cwd) ||
    !object(s.environment) ||
    typeof s.environment.select !== "function" ||
    !object(s.state) ||
    typeof s.state.get !== "function" ||
    typeof s.state.put !== "function" ||
    typeof s.state.now !== "function" ||
    !object(s.process) ||
    typeof s.process.run !== "function" ||
    typeof s.process.resolve !== "function"
  )
    fail(
      "SERVICE_MISSING",
      "The pull request block requires bound state, environment and process services",
    );
  return value as Services;
}
function key(r: Ref): string {
  return `pr:${r.repository}:${r.number}`;
}
function same(r: Ref, e: Ref): boolean {
  return (
    r.repository.toLowerCase() === e.repository.toLowerCase() &&
    r.number === e.number
  );
}
function evidence(value: unknown, r: Ref): Evidence | undefined {
  if (
    !object(value) ||
    !string(value.repository) ||
    !Number.isSafeInteger(value.number) ||
    !same(r, value as unknown as Ref) ||
    !sha(value.headSha) ||
    !sha(value.baseSha) ||
    !sha(value.mergeableHeadSha) ||
    !enumValue(value.state, ["OPEN", "CLOSED", "MERGED"]) ||
    typeof value.draft !== "boolean" ||
    !enumValue(value.mergeable, ["MERGEABLE", "CONFLICTING", "UNKNOWN"]) ||
    typeof value.complete !== "boolean" ||
    !Number.isSafeInteger(value.lastActivityAt) ||
    Number(value.lastActivityAt) < 0
  )
    return undefined;
  if (
    !Array.isArray(value.checks) ||
    !value.checks.every(
      (v: unknown) =>
        object(v) &&
        string(v.name) &&
        (v.appId === null ||
          (Number.isSafeInteger(v.appId) && Number(v.appId) > 0)) &&
        sha(v.headSha) &&
        enumValue(v.status, [
          "QUEUED",
          "IN_PROGRESS",
          "PENDING",
          "COMPLETED",
        ]) &&
        (v.conclusion === null ||
          [
            "SUCCESS",
            "NEUTRAL",
            "SKIPPED",
            "FAILURE",
            "CANCELLED",
            "TIMED_OUT",
            "ACTION_REQUIRED",
            "STALE",
            "STARTUP_FAILURE",
          ].includes(typeof v.conclusion === "string" ? v.conclusion : "")),
    )
  )
    return undefined;
  if (
    !Array.isArray(value.requiredChecks) ||
    !value.requiredChecks.every(
      (v: unknown) =>
        object(v) &&
        string(v.name) &&
        (v.appId === null ||
          (Number.isSafeInteger(v.appId) && Number(v.appId) > 0)),
    )
  )
    return undefined;
  if (
    !Array.isArray(value.reviews) ||
    !value.reviews.every(
      (v: unknown) =>
        object(v) &&
        string(v.id) &&
        enumValue(v.state, [
          "APPROVED",
          "CHANGES_REQUESTED",
          "COMMENTED",
          "DISMISSED",
          "PENDING",
        ]) &&
        sha(v.headSha) &&
        Number.isSafeInteger(v.updatedAt) &&
        Number(v.updatedAt) >= 0,
    )
  )
    return undefined;
  if (
    !Array.isArray(value.threads) ||
    !value.threads.every(
      (v: unknown) =>
        object(v) &&
        string(v.id) &&
        sha(v.headSha) &&
        typeof v.resolved === "boolean",
    ) ||
    !Array.isArray(value.findings) ||
    !value.findings.every(
      (v: unknown) =>
        object(v) &&
        string(v.label) &&
        sha(v.headSha) &&
        typeof v.resolved === "boolean",
    )
  )
    return undefined;
  const protection = value.protection;
  if (
    !object(protection) ||
    !sha(protection.headSha) ||
    !sha(protection.baseSha) ||
    typeof protection.strictStatusChecks !== "boolean" ||
    typeof protection.atomicBaseCondition !== "boolean"
  )
    return undefined;
  const comparison = protection.baseComparison;
  if (
    comparison !== null &&
    (!object(comparison) ||
      !sha(comparison.headSha) ||
      !sha(comparison.baseSha) ||
      !Number.isSafeInteger(comparison.behindBy) ||
      Number(comparison.behindBy) < 0)
  )
    return undefined;
  const e = value as unknown as Evidence;
  if (
    new Set(e.reviews.map((v) => v.id)).size !== e.reviews.length ||
    new Set(e.threads.map((v) => v.id)).size !== e.threads.length
  )
    return undefined;
  return {
    repository: r.repository,
    number: r.number,
    headSha: e.headSha.toLowerCase(),
    baseSha: e.baseSha.toLowerCase(),
    state: e.state,
    draft: e.draft,
    mergeable: e.mergeable,
    mergeableHeadSha: e.mergeableHeadSha.toLowerCase(),
    protection: {
      headSha: e.protection.headSha.toLowerCase(),
      baseSha: e.protection.baseSha.toLowerCase(),
      strictStatusChecks: e.protection.strictStatusChecks,
      atomicBaseCondition: e.protection.atomicBaseCondition,
      baseComparison:
        e.protection.baseComparison === null
          ? null
          : {
              headSha: e.protection.baseComparison.headSha.toLowerCase(),
              baseSha: e.protection.baseComparison.baseSha.toLowerCase(),
              behindBy: e.protection.baseComparison.behindBy,
            },
    },
    complete: e.complete,
    checks: e.checks.map((v) => ({
      name: v.name,
      appId: v.appId,
      headSha: v.headSha.toLowerCase(),
      status: v.status,
      conclusion: v.conclusion,
    })),
    requiredChecks: e.requiredChecks.map((v) => ({
      name: v.name,
      appId: v.appId,
    })),
    reviews: e.reviews.map((v) => ({
      id: v.id,
      author: string(v.author) ? v.author : null,
      state: v.state,
      headSha: v.headSha.toLowerCase(),
      updatedAt: v.updatedAt,
      authorizing: string(v.author) && v.authorizing === true,
    })),
    threads: e.threads.map((v) => ({
      id: v.id,
      resolved: v.resolved,
      headSha: v.headSha.toLowerCase(),
    })),
    findings: e.findings.map((v) => ({
      label: v.label,
      resolved: v.resolved,
      headSha: v.headSha.toLowerCase(),
    })),
    lastActivityAt: e.lastActivityAt,
  };
}
function compute(
  e: Evidence | undefined,
  c: Config,
  now: number,
): { status: Status; reasons: string[] } {
  const stale: string[] = [];
  const result = (status: Status, reason?: string) => ({
    status,
    reasons: [...(reason === undefined ? [] : [reason]), ...stale],
  });
  if (!e || !e.complete || e.lastActivityAt > now)
    return result(
      "INCOMPLETE",
      "Provider evidence is missing, malformed, truncated or unreadable",
    );
  // A provider may return historical observations; only this head contributes authority.
  const checks = e.checks.filter((value) => value.headSha === e.headSha);
  const reviews = e.reviews.filter((value) => value.headSha === e.headSha);
  const threads = e.threads.filter((value) => value.headSha === e.headSha);
  const findings = e.findings.filter((value) => value.headSha === e.headSha);
  for (const [kind, count] of [
    ["check", e.checks.length - checks.length],
    ["review", e.reviews.length - reviews.length],
    ["thread", e.threads.length - threads.length],
    ["finding", e.findings.length - findings.length],
  ] as const)
    if (count > 0)
      stale.push(
        `Ignored ${count} stale ${kind} observation(s) for another head`,
      );
  if (e.state === "MERGED" || e.state === "CLOSED") return result(e.state);
  if (e.mergeableHeadSha !== e.headSha) {
    stale.push("Ignored stale mergeability observation for another head");
    return result(
      "INCOMPLETE",
      "Current-head mergeability evidence is missing",
    );
  }
  const protection = e.protection;
  if (protection.headSha !== e.headSha || protection.baseSha !== e.baseSha)
    return result(
      "INCOMPLETE",
      "Required-check policy is stale for the current head or base",
    );
  if (protection.strictStatusChecks) {
    const comparison = protection.baseComparison;
    if (
      !comparison ||
      comparison.headSha !== e.headSha ||
      comparison.baseSha !== e.baseSha
    )
      return result(
        "INCOMPLETE",
        "Strict required checks need a comparison bound to the current head and base",
      );
    if (comparison.behindBy > 0)
      return result(
        "CHECKS_PENDING",
        "Strict required checks need the head to include the current base",
      );
    if (!protection.atomicBaseCondition)
      return result(
        "INCOMPLETE",
        "Strict required checks need a provider with an atomic base condition; direct merge is unavailable",
      );
  }
  if (e.draft) return result("DRAFT", "Pull request is a draft");
  if (e.mergeable === "UNKNOWN")
    return result("INCOMPLETE", "Provider mergeability is unknown");
  if (e.mergeable === "CONFLICTING")
    return result("CONFLICTING", "Pull request conflicts with its base");
  if (!c.allowNoChecks && checks.length === 0 && e.requiredChecks.length === 0)
    return result(
      "INCOMPLETE",
      "No check evidence exists and the configured policy requires checks",
    );
  const required = new Map<string, number | null>();
  for (const check of e.requiredChecks) {
    if (required.has(check.name) && required.get(check.name) !== check.appId)
      return result("INCOMPLETE", "Required check identities conflict");
    required.set(check.name, check.appId);
  }
  for (const check of e.requiredChecks) {
    const found = checks.filter(
      (v) =>
        v.name === check.name &&
        (check.appId === null || v.appId === check.appId),
    );
    if (found.length === 0 || found.some((v) => v.headSha !== e.headSha))
      return result(
        "CHECKS_PENDING",
        "Required check evidence is missing for this exact head",
      );
    if (
      found.some((v) => v.status === "COMPLETED" && v.conclusion !== "SUCCESS")
    )
      return result(
        "CHECKS_FAILED",
        "A protected required check did not succeed",
      );
    if (found.some((v) => v.status !== "COMPLETED"))
      return result("CHECKS_PENDING", "A protected required check is pending");
  }
  if (c.optionalChecks === "safe-terminal")
    for (const check of checks) {
      if (
        e.requiredChecks.some(
          (r) =>
            r.name === check.name &&
            (r.appId === null || r.appId === check.appId),
        )
      )
        continue;
      if (check.headSha !== e.headSha)
        return result(
          "INCOMPLETE",
          "Optional check evidence belongs to a different head",
        );
      if (check.status !== "COMPLETED")
        return result(
          "CHECKS_PENDING",
          "An optional check is pending under the selected policy",
        );
      if (!["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion ?? ""))
        return result(
          "CHECKS_FAILED",
          "An optional check failed under the selected policy",
        );
    }
  if (
    threads.some((t) => !t.resolved) ||
    findings.some((f) => !f.resolved && c.blockingLabels.includes(f.label))
  )
    return result(
      "REVIEW_BLOCKED",
      "An unresolved thread or blocking finding remains",
    );
  const latest = new Map<string, Review>();
  // Historical comments carry no approval authority and cannot invalidate a later head.
  for (const review of reviews) {
    if (!review.author) continue;
    if (review.state === "COMMENTED" || review.state === "DISMISSED") continue;
    const actor = review.author.toLowerCase(),
      prior = latest.get(actor);
    if (!prior || review.updatedAt > prior.updatedAt) latest.set(actor, review);
    else if (
      review.updatedAt === prior.updatedAt &&
      review.id !== prior.id &&
      (review.authorizing || prior.authorizing)
    )
      return result("INCOMPLETE", "Review order is ambiguous");
  }
  let approvals = 0;
  for (const review of latest.values()) {
    if (!review.authorizing) continue;
    if (review.headSha !== e.headSha)
      return result(
        "REVIEW_REQUIRED",
        "An active authorizing review belongs to an earlier head",
      );
    if (review.state !== "APPROVED")
      return result(
        "REVIEW_BLOCKED",
        "A reviewer requested changes or has a pending review",
      );
    approvals++;
  }
  if (approvals < c.minApprovals)
    return result(
      "REVIEW_REQUIRED",
      "The configured approval count has not been reached",
    );
  const activityAt = Math.max(
    e.lastActivityAt,
    ...reviews.map((v) => v.updatedAt),
  );
  if (activityAt > now)
    return result("INCOMPLETE", "Review activity is future-dated");
  if (now - activityAt < c.settleMs)
    return result(
      "SETTLING",
      "Review activity has not settled for the configured interval",
    );
  return result("MERGE_READY");
}
async function provider(
  call: Call,
  c: Config,
  s: Services,
  action: string,
  payload: Json,
  beforeLaunch?: () => number,
): Promise<unknown> {
  if (call.signal.aborted)
    fail("INVOCATION_ABORTED", "Invocation was cancelled");
  if (call.deadline <= s.state.now())
    fail("INVOCATION_TIMEOUT", "Invocation deadline exceeded");
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries({
    ...s.environment.select(c.envNames),
    ...s.identity?.env,
  })) {
    if (
      !/^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_CONFIG|GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS|GIT_NAMESPACE|GIT_CEILING_DIRECTORIES|GIT_DISCOVERY_ACROSS_FILESYSTEM)$/i.test(
        name,
      ) &&
      !/^GIT_CONFIG_(KEY|VALUE)_/i.test(name)
    )
      env[name] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  const executable = s.process.resolve(c.provider.executable, env);
  if (executable.kind !== "resolved")
    fail("UNAVAILABLE", "Configured provider executable is unavailable");
  const leaseBudget = beforeLaunch?.() ?? c.provider.timeoutMs;
  if (call.signal.aborted)
    fail("INVOCATION_ABORTED", "Invocation was cancelled");
  const remaining = Math.min(
    c.provider.timeoutMs,
    call.deadline - s.state.now(),
    leaseBudget,
  );
  if (remaining <= 0)
    fail(
      "INVOCATION_TIMEOUT",
      "Invocation or held lease expired before provider launch",
    );
  const result = await s.process.run(
    executable,
    action === "status" ? c.provider.readArgs : c.provider.writeArgs,
    {
      cwd: s.process.cwd,
      env,
      timeoutMs: Math.max(1, remaining),
      maxOutputBytes: c.provider.maxOutputBytes,
      stdin: JSON.stringify({ action, payload }),
      signal: call.signal,
    },
  );
  if (result.timedOut || result.truncated || result.exitCode !== 0)
    fail(
      action === "status" ? "PROVIDER_FAILED" : "EFFECT_UNCERTAIN",
      action === "status"
        ? "Provider read failed or exceeded its budget"
        : "Provider mutation outcome is uncertain; read and reconcile before retrying",
    );
  let value: unknown;
  try {
    value = JSON.parse(result.stdout) as unknown;
  } catch {
    fail("PROVIDER_FAILED", "Provider did not return a JSON value");
  }
  if (!object(value) || value.ok !== true || !("result" in value))
    fail(
      "PROVIDER_FAILED",
      "Provider did not return a successful Forge result envelope",
    );
  if (action === "merge" && object(value.result)) {
    const merged = value.result;
    return {
      ...merged,
      ...(sha(merged.headSha) ? { headSha: merged.headSha.toLowerCase() } : {}),
      ...(sha(merged.mergeSha)
        ? { mergeSha: merged.mergeSha.toLowerCase() }
        : {}),
    };
  }
  return value.result;
}
async function read(call: Call, c: Config, s: Services, r: Ref) {
  let value: unknown;
  try {
    value = await provider(call, c, s, "status", { ...r });
  } catch {
    value = undefined;
  }
  const e = evidence(value, r);
  return { ...r, evidence: e ?? null, verdict: compute(e, c, s.state.now()) };
}
function template(text: string, r: Ref): string {
  return text
    .split("{repository}")
    .join(r.repository)
    .split("{number}")
    .join(String(r.number));
}
function noTrailers(text: string): void {
  if (/(?:^|\n)\s*co-authored-by\s*:/i.test(text))
    fail("INPUT_INVALID", "Squash text must not contain coauthor trailers");
}
const operations = {
  "pr.status": async (call: Call) => {
    const c = config(call.config),
      s = services(call.services);
    return read(call, c, s, ref(call.input));
  },
  "pr.checks": async (call: Call) => {
    const c = config(call.config),
      s = services(call.services);
    const view = await read(call, c, s, ref(call.input));
    return { ...view, checks: view.evidence?.checks ?? [] };
  },
  "pr.threads": async (call: Call) => {
    const c = config(call.config),
      s = services(call.services);
    const view = await read(call, c, s, ref(call.input));
    return { ...view, threads: view.evidence?.threads ?? [] };
  },
  "pr.create": async (call: Call) => {
    const c = config(call.config),
      s = services(call.services);
    const value = requireObject(
      await provider(call, c, s, "create", call.input),
    );
    const r = ref(value);
    if (
      typeof value.url !== "string" ||
      !/^https:\/\/[A-Za-z0-9.-]+\//.test(value.url) ||
      /[?#@]/.test(value.url)
    )
      fail(
        "PROVIDER_FAILED",
        "Provider create response must include a safe pull request URL",
      );
    const record = s.state.put(
      key(r),
      { ...r, url: value.url },
      { expectRevision: 0 },
    );
    return { ...r, revision: record.revision, url: value.url };
  },
  "pr.link": async (call: Call) => {
    const c = config(call.config),
      s = services(call.services),
      r = ref(call.input);
    const view = await read(call, c, s, r);
    if (!view.evidence)
      fail("INCOMPLETE", "Cannot link an unreadable pull request");
    if (
      !Number.isSafeInteger(call.input.expectRevision) ||
      Number(call.input.expectRevision) < 0
    )
      fail("INPUT_INVALID", "Link requires a nonnegative expected revision");
    const record = s.state.put(key(r), r, {
      expectRevision: Number(call.input.expectRevision),
    });
    return { ...view, revision: record.revision };
  },
  "pr.claim": (call: Call) => {
    const c = config(call.config),
      s = services(call.services),
      r = ref(call.input);
    return s.state.acquire(key(r), c.leaseMs);
  },
  "pr.renew": (call: Call) => {
    const c = config(call.config),
      s = services(call.services),
      r = ref(call.input);
    return s.state.renew(key(r), c.leaseMs);
  },
  "pr.release": (call: Call) => {
    const s = services(call.services),
      r = ref(call.input);
    return s.state.release(key(r));
  },
  "pr.reply": async (call: Call) => {
    const c = config(call.config),
      s = services(call.services);
    ref(call.input);
    if (!string(call.input.threadId) || !string(call.input.body))
      fail(
        "INPUT_INVALID",
        "Reply requires a specific thread ID and nonempty body",
      );
    const result = requireObject(
      await provider(call, c, s, "reply", call.input),
    );
    if (result.accepted !== true)
      fail(
        "EFFECT_UNCERTAIN",
        "Provider did not confirm the mutation; read and reconcile before retrying",
      );
    return {
      ...ref(call.input),
      threadId: call.input.threadId,
      accepted: true,
    };
  },
  "pr.resolve": async (call: Call) => {
    const c = config(call.config),
      s = services(call.services);
    ref(call.input);
    if (!string(call.input.threadId))
      fail("INPUT_INVALID", "Resolve requires a specific thread ID");
    const result = requireObject(
      await provider(call, c, s, "resolve", call.input),
    );
    if (result.accepted !== true)
      fail(
        "EFFECT_UNCERTAIN",
        "Provider did not confirm the mutation; read and reconcile before retrying",
      );
    return {
      ...ref(call.input),
      threadId: call.input.threadId,
      accepted: true,
    };
  },
  "pr.rerun": async (call: Call) => {
    const c = config(call.config),
      s = services(call.services);
    ref(call.input);
    if (
      !Number.isSafeInteger(call.input.runId) ||
      Number(call.input.runId) <= 0
    )
      fail("INPUT_INVALID", "Rerun requires a specific positive run ID");
    const result = requireObject(
      await provider(call, c, s, "rerun", call.input),
    );
    if (result.accepted !== true)
      fail(
        "EFFECT_UNCERTAIN",
        "Provider did not confirm the mutation; read and reconcile before retrying",
      );
    return { ...ref(call.input), runId: call.input.runId, accepted: true };
  },
  "pr.merge": async (call: Call) => {
    const c = config(call.config),
      s = services(call.services),
      r = ref(call.input);
    if (
      !Number.isSafeInteger(call.input.expectRevision) ||
      Number(call.input.expectRevision) < 0
    )
      fail(
        "INPUT_INVALID",
        "Merge requires a nonnegative expected state revision",
      );
    if (!sha(call.input.expectHead))
      fail("INPUT_INVALID", "Merge requires the exact expected head SHA");
    const expectHead = call.input.expectHead.toLowerCase();
    const title = template(
        typeof call.input.title === "string" ? call.input.title : c.squashTitle,
        r,
      ),
      body = template(
        typeof call.input.body === "string" ? call.input.body : c.squashBody,
        r,
      );
    if (!title.trim()) fail("INPUT_INVALID", "Squash title must not be empty");
    noTrailers(title);
    noTrailers(body);
    const view = await read(call, c, s, r);
    if (!view.evidence || view.evidence.headSha !== expectHead)
      fail(
        "HEAD_MOVED",
        "The pull request head no longer matches the caller's pinned head",
      );
    if (view.verdict.status !== "MERGE_READY")
      fail("MERGE_BLOCKED", `Merge verdict is ${view.verdict.status}`);
    const current = s.state.get(key(r));
    if ((current?.revision ?? 0) !== call.input.expectRevision)
      fail("REVISION_CONFLICT", "Pull request state changed before merge");
    let intentRevision: number | undefined;
    const merged = requireObject(
      await provider(
        call,
        c,
        s,
        "merge",
        {
          ...r,
          expectHead,
          expectBase: view.evidence.baseSha,
          evidence: view.evidence,
          title,
          body,
        },
        () => {
          // Fence after executable resolution, with no await before the external process launch.
          const intent = s.state.put(
            key(r),
            {
              ...r,
              phase: "merging",
              headSha: expectHead,
              evidence: view.evidence,
            },
            {
              expectRevision: Number(call.input.expectRevision),
              subject: key(r),
            },
          );
          intentRevision = intent.revision;
          const lease = s.state.lease(key(r));
          if (!lease) fail("LEASE_STALE", "Held pull request lease is missing");
          return Date.parse(lease.expiresAt) - s.state.now();
        },
      ),
    );
    if (intentRevision === undefined)
      fail("LEASE_STALE", "Merge launched without a fenced intent");
    if (merged.merged === false) {
      const fresh = evidence(merged.evidence, r);
      const verdict = compute(fresh, c, s.state.now());
      fail(
        "MERGE_BLOCKED",
        `Fresh merge verdict is ${verdict.status}: ${verdict.reasons.join("; ") || "Evidence changed at the provider boundary; read again"}`,
      );
    }
    if (merged.merged !== true || merged.headSha !== expectHead)
      fail(
        "INCOMPLETE",
        "Provider did not confirm merging the pinned head; reconcile before retrying",
      );
    const accepted = s.state.put(
      key(r),
      {
        ...r,
        phase: "merged",
        headSha: expectHead,
        merge: {
          merged: true,
          headSha: expectHead,
          ...(sha(merged.mergeSha) ? { mergeSha: merged.mergeSha } : {}),
        },
      },
      { expectRevision: intentRevision, subject: key(r) },
    );
    const fresh = await read(call, c, s, r);
    if (
      fresh.verdict.status !== "MERGED" ||
      fresh.evidence?.headSha !== expectHead
    )
      fail(
        "INCOMPLETE",
        "Merge was accepted but provider readback did not confirm it",
      );
    return { ...fresh, revision: accepted.revision };
  },
};
module.exports = operations;
