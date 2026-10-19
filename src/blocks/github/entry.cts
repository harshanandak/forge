import type { ProcessPort } from "../../ports/process.ts";

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
  readonly executable: string;
  readonly account?: string;
  readonly host?: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly pageSize: number;
  readonly maxPages: number;
}
interface Services {
  readonly process: ProcessPort & { readonly cwd: string };
  readonly environment: {
    select(names: readonly string[]): Readonly<Record<string, string>>;
  };
  readonly identity?: {
    readonly account: string;
    readonly host: string;
    readonly env: Readonly<Record<string, string>>;
  };
}
interface Selected {
  readonly config: Config;
  readonly services: Services;
  readonly account: string;
  readonly host: string;
  readonly env: Readonly<Record<string, string>>;
}
interface Ref {
  readonly repository: string;
  readonly number: number;
}
function object(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function obj(value: unknown): Json {
  if (!object(value))
    fail("INCOMPLETE", "Provider evidence is missing or malformed");
  return value;
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function enumValue(value: unknown, values: readonly string[]): value is string {
  return typeof value === "string" && values.includes(value);
}
function sha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
}
function stamp(value: unknown): number {
  if (
    !text(value) ||
    !/^\d{4}-\d\d-\d\dT/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    fail("INCOMPLETE", "Provider activity timestamp is missing or malformed");
  return Date.parse(value);
}
function repository(input: Json): string {
  if (
    typeof input.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)
  )
    fail("INPUT_INVALID", "An explicit owner/repository is required");
  return input.repository.toLowerCase();
}
function ref(input: Json): Ref {
  repository(input);
  if (!Number.isSafeInteger(input.number) || Number(input.number) < 1)
    fail(
      "INPUT_INVALID",
      "An explicit repository and positive pull request number are required",
    );
  return { repository: repository(input), number: Number(input.number) };
}
function selected(call: Call): Selected {
  if (!object(call.config))
    fail(
      "INPUT_INVALID",
      "GitHub executable, identity and bounded resource configuration are required",
    );
  const c = call.config;
  if (
    !Array.isArray(c.envNames) ||
    c.envNames.length > 256 ||
    !c.envNames.every(
      (v: unknown) =>
        typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(v),
    )
  )
    fail("INPUT_INVALID", "Explicit bounded environment names are required");
  if (!text(c.executable))
    fail("INPUT_INVALID", "A provider executable must be configured");
  for (const [name, low, high] of [
    ["timeoutMs", 1, 300000],
    ["maxOutputBytes", 1024, 1048576],
    ["pageSize", 1, 100],
    ["maxPages", 1, 100],
  ] as const)
    if (
      !Number.isSafeInteger(c[name]) ||
      Number(c[name]) < low ||
      Number(c[name]) > high
    )
      fail("INPUT_INVALID", `Invalid ${name}`);
  if (
    !object(call.services) ||
    !object(call.services.process) ||
    typeof call.services.process.run !== "function" ||
    typeof call.services.process.resolve !== "function" ||
    !text(call.services.process.cwd) ||
    !object(call.services.environment) ||
    typeof call.services.environment.select !== "function"
  )
    fail(
      "SERVICE_MISSING",
      "GitHub requires bound environment and process services",
    );
  const s = call.services as unknown as Services;
  const account = c.account ?? s.identity?.account,
    host = c.host ?? s.identity?.host;
  if (
    !text(account) ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(account) ||
    !text(host) ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) ||
    host.length > 253
  )
    fail(
      "INPUT_INVALID",
      "An explicit provider login and hostname are required",
    );
  if (
    s.identity &&
    ((c.account !== undefined && c.account !== s.identity.account) ||
      (c.host !== undefined && c.host !== s.identity.host))
  )
    fail(
      "IDENTITY_MISMATCH",
      "Configured identity differs from the selected host identity",
    );
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries({
    ...s.environment.select(c.envNames as string[]),
    ...s.identity?.env,
  })) {
    if (
      !/^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_CONFIG|GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS|GIT_NAMESPACE|GIT_CEILING_DIRECTORIES|GIT_DISCOVERY_ACROSS_FILESYSTEM|GH_REPO|GH_HOST|GH_DEBUG)$/i.test(
        name,
      ) &&
      !/^GIT_CONFIG_(KEY|VALUE)_/i.test(name)
    )
      env[name] = value;
  }
  env.GH_HOST = host;
  env.GH_PROMPT_DISABLED = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GH_PAGER = "cat";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  return { config: c as unknown as Config, services: s, account, host, env };
}
function active(call: Call): number {
  if (call.signal.aborted)
    fail("INVOCATION_ABORTED", "Invocation was cancelled");
  const remaining = call.deadline - Date.now();
  if (remaining <= 0)
    fail("INVOCATION_TIMEOUT", "Invocation deadline exceeded");
  return remaining;
}
async function command(
  call: Call,
  s: Selected,
  endpoint: string,
  method: "GET" | "POST" | "PUT",
  input?: Json,
  mutation = false,
): Promise<unknown> {
  const remaining = active(call);
  const executable = s.services.process.resolve(s.config.executable, s.env);
  if (executable.kind !== "resolved")
    fail(
      "UNAVAILABLE",
      "GitHub executable is unavailable; install the configured executable or select another provider",
    );
  const result = await s.services.process.run(
    executable,
    [
      "api",
      "--hostname",
      s.host,
      "--method",
      method,
      endpoint,
      ...(input === undefined ? [] : ["--input", "-"]),
    ],
    {
      cwd: s.services.process.cwd,
      env: s.env,
      timeoutMs: Math.max(1, Math.min(s.config.timeoutMs, remaining)),
      maxOutputBytes: s.config.maxOutputBytes,
      ...(input === undefined ? {} : { stdin: JSON.stringify(input) }),
      signal: call.signal,
    },
  );
  if (result.timedOut || result.truncated || result.exitCode !== 0)
    fail(
      mutation ? "EFFECT_UNCERTAIN" : "INCOMPLETE",
      mutation
        ? "GitHub mutation outcome is uncertain; read and reconcile before retrying"
        : "GitHub read failed or exceeded its resource budget",
    );
  active(call);
  if (
    mutation &&
    endpoint.endsWith("/rerun-failed-jobs") &&
    result.stdout.trim() === ""
  )
    return {};
  let value: unknown;
  try {
    value = JSON.parse(result.stdout) as unknown;
  } catch {
    fail(
      mutation ? "EFFECT_UNCERTAIN" : "INCOMPLETE",
      "GitHub returned incomplete JSON; read and reconcile before retrying a mutation",
    );
  }
  if (object(value) && value.errors !== undefined)
    fail(
      mutation ? "EFFECT_UNCERTAIN" : "INCOMPLETE",
      "GitHub rejected the request; no provider error text is exposed",
    );
  return value;
}
async function verify(call: Call, s: Selected) {
  const user = obj(await command(call, s, "user", "GET"));
  if (
    typeof user.login !== "string" ||
    user.login.toLowerCase() !== s.account.toLowerCase()
  )
    fail(
      "IDENTITY_MISMATCH",
      "Authenticated GitHub login does not match the explicitly selected account",
    );
}
async function graphql(
  call: Call,
  s: Selected,
  query: string,
  variables: Json,
  mutation = false,
): Promise<Json> {
  const result = obj(
    await command(call, s, "graphql", "POST", { query, variables }, mutation),
  );
  return obj(result.data);
}
const coreFields =
  "headRefOid baseRefOid baseRefName state isDraft mergeable updatedAt baseRef { branchProtectionRule { requiredStatusChecks { context appId } requiresStrictStatusChecks requiresApprovingReviews requiresCodeOwnerReviews restrictsPushes requiresCommitSignatures } }";
async function prQuery(
  call: Call,
  s: Selected,
  r: Ref,
  name: string,
  fields: string,
  variables: Json = {},
  declarations = "",
): Promise<Json> {
  const [owner, repo] = r.repository.split("/");
  const query = `query ${name}($owner:String!,$repo:String!,$number:Int!${declarations}) {repository(owner:$owner,name:$repo){pullRequest(number:$number){${fields}}}}`;
  const data = await graphql(call, s, query, {
    owner,
    repo,
    number: r.number,
    ...variables,
  });
  return obj(obj(data.repository).pullRequest);
}
async function core(call: Call, s: Selected, r: Ref): Promise<Json> {
  const value = await prQuery(call, s, r, "ForgePRCore", coreFields);
  if (
    !sha(value.headRefOid) ||
    !sha(value.baseRefOid) ||
    !text(value.baseRefName) ||
    !enumValue(value.state, ["OPEN", "CLOSED", "MERGED"]) ||
    typeof value.isDraft !== "boolean" ||
    !enumValue(value.mergeable, ["MERGEABLE", "CONFLICTING", "UNKNOWN"]) ||
    !object(value.baseRef) ||
    !("branchProtectionRule" in value.baseRef)
  )
    fail("INCOMPLETE", "GitHub core evidence is incomplete");
  stamp(value.updatedAt);
  return value;
}
type ConnectionKind = "Checks" | "Reviews" | "Threads" | "Labels";
const connectionFields: Record<ConnectionKind, string> = {
  Checks:
    "commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:$first,after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{id __typename ... on CheckRun{name status conclusion checkSuite{app{databaseId} commit{oid}}} ... on StatusContext{context state commit{oid}}}}}}}}",
  Reviews:
    "reviews(first:$first,after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{id author{login} state commit{oid} updatedAt}}",
  Threads:
    "reviewThreads(first:$first,after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{id isResolved comments(last:1){nodes{updatedAt}}}}",
  Labels:
    "labels(first:$first,after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{name}}",
};
function connection(
  value: Json,
  kind: ConnectionKind,
  expectedHead: unknown,
): Json {
  if (kind !== "Checks")
    return obj(
      value[
        kind === "Reviews"
          ? "reviews"
          : kind === "Threads"
            ? "reviewThreads"
            : "labels"
      ],
    );
  const commits = obj(value.commits).nodes;
  if (!Array.isArray(commits) || commits.length !== 1)
    fail("INCOMPLETE", "Exact-head commit evidence is missing");
  const commit = obj(obj(commits[0]).commit);
  if (commit.oid !== expectedHead)
    fail("INCOMPLETE", "Check evidence belongs to a different head");
  // A null rollup is the provider's explicit statement that this commit has no checks.
  if (commit.statusCheckRollup === null)
    return {
      nodes: [],
      totalCount: 0,
      pageInfo: { hasNextPage: false, endCursor: null },
    };
  return obj(obj(commit.statusCheckRollup).contexts);
}
async function pages(
  call: Call,
  s: Selected,
  r: Ref,
  kind: ConnectionKind,
  expectedHead: unknown,
): Promise<Json[]> {
  const values: Json[] = [],
    cursors = new Set<string>(),
    identities = new Set<string>();
  let after: string | null = null,
    total: number | undefined;
  for (let page = 0; page < s.config.maxPages; page++) {
    const value = await prQuery(
      call,
      s,
      r,
      `ForgePR${kind}`,
      connectionFields[kind],
      { first: s.config.pageSize, after },
      ",$first:Int!,$after:String",
    );
    const found = connection(value, kind, expectedHead),
      info = obj(found.pageInfo);
    if (
      !Array.isArray(found.nodes) ||
      found.nodes.length > s.config.pageSize ||
      !found.nodes.every(object) ||
      !Number.isSafeInteger(found.totalCount) ||
      Number(found.totalCount) < 0 ||
      typeof info.hasNextPage !== "boolean" ||
      !("endCursor" in info) ||
      (info.endCursor !== null && !text(info.endCursor))
    )
      fail("INCOMPLETE", "A GitHub evidence page is incomplete");
    if (total !== undefined && total !== found.totalCount)
      fail("INCOMPLETE", "GitHub evidence changed during pagination");
    for (const raw of found.nodes) {
      const node = obj(raw),
        identity = kind === "Labels" ? node.name : node.id;
      if (!text(identity) || identities.has(identity))
        fail(
          "INCOMPLETE",
          "GitHub evidence contains missing or repeated node identities",
        );
      identities.add(identity);
    }
    total = Number(found.totalCount);
    values.push(...found.nodes);
    if (!info.hasNextPage) {
      if (values.length !== total)
        fail(
          "INCOMPLETE",
          "GitHub evidence page count does not match its total",
        );
      return values;
    }
    if (
      !text(info.endCursor) ||
      cursors.has(info.endCursor) ||
      found.nodes.length === 0 ||
      values.length >= total
    )
      fail("INCOMPLETE", "GitHub evidence pagination did not make progress");
    cursors.add(info.endCursor);
    after = info.endCursor;
  }
  fail(
    "INCOMPLETE",
    "GitHub evidence exceeds the configured pagination budget",
  );
}
function check(value: Json): Json {
  if (value.__typename === "CheckRun") {
    const suite = obj(value.checkSuite),
      app = obj(suite.app);
    if (
      !text(value.name) ||
      !Number.isSafeInteger(app.databaseId) ||
      Number(app.databaseId) < 1 ||
      !sha(obj(suite.commit).oid) ||
      !enumValue(value.status, [
        "QUEUED",
        "IN_PROGRESS",
        "COMPLETED",
        "PENDING",
        "WAITING",
        "REQUESTED",
      ]) ||
      !(
        value.conclusion === null ||
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
        ].includes(typeof value.conclusion === "string" ? value.conclusion : "")
      )
    )
      fail("INCOMPLETE", "A GitHub check run is malformed or stale");
    return {
      name: value.name,
      appId: app.databaseId,
      headSha: obj(suite.commit).oid,
      status: enumValue(value.status, ["WAITING", "REQUESTED"])
        ? "PENDING"
        : value.status,
      conclusion: value.conclusion,
    };
  }
  if (
    value.__typename === "StatusContext" &&
    text(value.context) &&
    sha(obj(value.commit).oid) &&
    enumValue(value.state, [
      "SUCCESS",
      "EXPECTED",
      "PENDING",
      "FAILURE",
      "ERROR",
    ])
  ) {
    const pending = value.state === "PENDING" || value.state === "EXPECTED";
    return {
      name: value.context,
      appId: null,
      headSha: obj(value.commit).oid,
      status: pending ? "PENDING" : "COMPLETED",
      conclusion: pending
        ? null
        : value.state === "SUCCESS"
          ? "SUCCESS"
          : "FAILURE",
    };
  }
  fail("INCOMPLETE", "A GitHub status context is malformed or unreadable");
}
async function requirements(
  call: Call,
  s: Selected,
  r: Ref,
  before: Json,
): Promise<{ checks: Json[]; strictStatusChecks: boolean }> {
  const rule = obj(before.baseRef).branchProtectionRule;
  let strictStatusChecks = false;
  const required: Json[] = [];
  if (rule !== null) {
    const classic = obj(rule);
    for (const flag of [
      "requiresStrictStatusChecks",
      "requiresApprovingReviews",
      "requiresCodeOwnerReviews",
      "restrictsPushes",
      "requiresCommitSignatures",
    ])
      if (typeof classic[flag] !== "boolean")
        fail(
          "INCOMPLETE",
          "Classic branch-protection requirements are unreadable",
        );
    if (
      [
        "requiresApprovingReviews",
        "requiresCodeOwnerReviews",
        "restrictsPushes",
        "requiresCommitSignatures",
      ].some((flag) => classic[flag] === true)
    )
      fail(
        "INCOMPLETE",
        "Classic branch protection has an unsupported review, identity or signature requirement",
      );
    strictStatusChecks = classic.requiresStrictStatusChecks as boolean;
    const checks = classic.requiredStatusChecks;
    if (!Array.isArray(checks))
      fail("INCOMPLETE", "Protected required checks are unreadable");
    for (const v of checks) {
      const item = obj(v);
      if (
        !text(item.context) ||
        !(
          item.appId === null ||
          (Number.isSafeInteger(item.appId) && Number(item.appId) > 0)
        )
      )
        fail("INCOMPLETE", "Protected check identity is malformed");
      required.push({ name: item.context, appId: item.appId });
    }
  }
  // Rulesets can add required checks beyond the classic branch-protection rule.
  for (let page = 1; page <= s.config.maxPages; page++) {
    const rules = await command(
      call,
      s,
      `repos/${r.repository}/rules/branches/${encodeURIComponent(String(before.baseRefName))}?per_page=${s.config.pageSize}&page=${page}`,
      "GET",
    );
    if (!Array.isArray(rules) || rules.length > s.config.pageSize)
      fail("INCOMPLETE", "Repository ruleset evidence is unreadable");
    for (const value of rules) {
      const item = obj(value);
      if (!text(item.type))
        fail("INCOMPLETE", "Repository ruleset evidence is malformed");
      if (item.type !== "required_status_checks") {
        // Squash merge already satisfies linear history and does not force-push or delete.
        if (
          ["required_linear_history", "non_fast_forward", "deletion"].includes(
            String(item.type),
          )
        )
          continue;
        fail(
          "INCOMPLETE",
          "An active GitHub merge rule has no complete evaluator",
        );
      }
      const parameters = obj(item.parameters);
      if (typeof parameters.strict_required_status_checks_policy !== "boolean")
        fail(
          "INCOMPLETE",
          "Ruleset strict required-check policy is unreadable",
        );
      strictStatusChecks ||= parameters.strict_required_status_checks_policy;
      const checks = parameters.required_status_checks;
      if (!Array.isArray(checks))
        fail("INCOMPLETE", "Ruleset required checks are unreadable");
      for (const raw of checks) {
        const check = obj(raw);
        if (
          !text(check.context) ||
          !(
            check.integration_id === null ||
            (Number.isSafeInteger(check.integration_id) &&
              Number(check.integration_id) > 0)
          )
        )
          fail("INCOMPLETE", "Ruleset check identity is malformed");
        required.push({ name: check.context, appId: check.integration_id });
      }
    }
    if (rules.length < s.config.pageSize)
      return {
        strictStatusChecks,
        checks: required.filter(
          (item, index) =>
            required.findIndex(
              (v) => v.name === item.name && v.appId === item.appId,
            ) === index,
        ),
      };
  }
  fail(
    "INCOMPLETE",
    "Ruleset evidence exceeds the configured pagination budget",
  );
}
async function gather(call: Call, s: Selected, r: Ref): Promise<Json> {
  const before = await core(call, s, r);
  const checks = (await pages(call, s, r, "Checks", before.headRefOid)).map(
    (value) => check(value),
  );
  const policy = await requirements(call, s, r, before);
  const requiredChecks = policy.checks;
  let baseComparison: Json | null = null;
  if (policy.strictStatusChecks) {
    const compared = obj(
      await command(
        call,
        s,
        `repos/${r.repository}/compare/${String(before.baseRefOid)}...${String(before.headRefOid)}`,
        "GET",
      ),
    );
    if (
      obj(compared.base_commit).sha !== before.baseRefOid ||
      !sha(obj(compared.merge_base_commit).sha) ||
      !Number.isSafeInteger(compared.behind_by) ||
      Number(compared.behind_by) < 0 ||
      !Number.isSafeInteger(compared.ahead_by) ||
      Number(compared.ahead_by) < 0
    )
      fail("INCOMPLETE", "Strict base comparison is missing or malformed");
    const ahead = Number(compared.ahead_by),
      behind = Number(compared.behind_by);
    const consistent =
      (compared.status === "identical" && ahead === 0 && behind === 0) ||
      (compared.status === "ahead" && ahead > 0 && behind === 0) ||
      (compared.status === "behind" && ahead === 0 && behind > 0) ||
      (compared.status === "diverged" && ahead > 0 && behind > 0);
    if (!consistent)
      fail("INCOMPLETE", "Strict base comparison is inconsistent");
    baseComparison = {
      headSha: before.headRefOid,
      baseSha: before.baseRefOid,
      behindBy: behind,
    };
  }
  let lastActivityAt = stamp(before.updatedAt);
  const reviews = (await pages(call, s, r, "Reviews", before.headRefOid)).map(
    (value) => {
      const author = obj(value.author),
        commit = obj(value.commit),
        updatedAt = stamp(value.updatedAt);
      if (
        !text(value.id) ||
        !text(author.login) ||
        !sha(commit.oid) ||
        !enumValue(value.state, [
          "APPROVED",
          "CHANGES_REQUESTED",
          "COMMENTED",
          "DISMISSED",
          "PENDING",
        ])
      )
        fail("INCOMPLETE", "Review identity, state or head is malformed");
      if (commit.oid === before.headRefOid)
        lastActivityAt = Math.max(lastActivityAt, updatedAt);
      return {
        id: value.id,
        author: author.login,
        state: value.state,
        headSha: commit.oid,
        updatedAt,
      };
    },
  );
  const threads = (await pages(call, s, r, "Threads", before.headRefOid)).map(
    (value) => {
      const comments = obj(value.comments).nodes;
      if (
        !text(value.id) ||
        typeof value.isResolved !== "boolean" ||
        !Array.isArray(comments) ||
        comments.length !== 1
      )
        fail("INCOMPLETE", "Review thread evidence is malformed");
      lastActivityAt = Math.max(
        lastActivityAt,
        stamp(obj(comments[0]).updatedAt),
      );
      return {
        id: value.id,
        resolved: value.isResolved,
        headSha: before.headRefOid,
      };
    },
  );
  const findings = (await pages(call, s, r, "Labels", before.headRefOid)).map(
    (value) => {
      if (!text(value.name)) fail("INCOMPLETE", "Label evidence is malformed");
      return { label: value.name, resolved: false, headSha: before.headRefOid };
    },
  );
  const after = await core(call, s, r);
  if (
    JSON.stringify(before) !== JSON.stringify(after) ||
    JSON.stringify(policy) !==
      JSON.stringify(await requirements(call, s, r, after))
  )
    fail(
      "INCOMPLETE",
      "Pull request changed during evidence collection; read it again",
    );
  return {
    ...r,
    headSha: before.headRefOid,
    baseSha: before.baseRefOid,
    state: before.state,
    draft: before.isDraft,
    mergeable: before.mergeable,
    mergeableHeadSha: before.headRefOid,
    protection: {
      headSha: before.headRefOid,
      baseSha: before.baseRefOid,
      strictStatusChecks: policy.strictStatusChecks,
      atomicBaseCondition: false,
      baseComparison,
    },
    checks,
    requiredChecks,
    reviews,
    threads,
    findings,
    lastActivityAt,
    complete: true,
  };
}
function protocol(
  call: Call,
  write: boolean,
): { action: string; payload: Json } {
  const input = call.input;
  if (
    !text(input.action) ||
    !(
      write ? ["create", "reply", "resolve", "rerun", "merge"] : ["status"]
    ).includes(input.action) ||
    !object(input.payload)
  )
    fail("INPUT_INVALID", "Unsupported provider action or missing payload");
  return { action: input.action, payload: input.payload };
}
function squash(payload: Json): void {
  if (
    !sha(payload.expectHead) ||
    !sha(payload.expectBase) ||
    !text(payload.title) ||
    !payload.title.trim() ||
    typeof payload.body !== "string" ||
    /(?:^|\n)\s*co-authored-by\s*:/i.test(`${payload.title}\n${payload.body}`)
  )
    fail(
      "INPUT_INVALID",
      "Merge requires exact head, explicit squash text and no coauthor trailers",
    );
}
async function mutate(call: Call): Promise<Json> {
  const { action, payload } = protocol(call, true),
    r =
      action === "create"
        ? { repository: repository(payload), number: 0 }
        : ref(payload);
  // Reject malformed payloads before even the identity probe.
  if (action === "merge") squash(payload);
  if ((action === "reply" || action === "resolve") && !text(payload.threadId))
    fail("INPUT_INVALID", "A specific review thread ID is required");
  if (action === "reply" && !text(payload.body))
    fail("INPUT_INVALID", "Reply body is required");
  if (
    action === "rerun" &&
    (!Number.isSafeInteger(payload.runId) || Number(payload.runId) < 1)
  )
    fail("INPUT_INVALID", "A specific positive workflow run ID is required");
  if (
    action === "create" &&
    (![payload.title, payload.head, payload.base].every(text) ||
      typeof payload.body !== "string" ||
      typeof payload.draft !== "boolean")
  )
    fail(
      "INPUT_INVALID",
      "Create requires explicit title, body, branches and draft selection",
    );
  const s = selected(call);
  await verify(call, s);
  if (action === "merge") {
    const current = await core(call, s, r);
    if (current.headRefOid !== payload.expectHead)
      fail("HEAD_MOVED", "Conditional merge head changed before launch");
    if (current.baseRefOid !== payload.expectBase)
      fail("BASE_MOVED", "Merge base changed before launch");
    const policy = await requirements(call, s, r, current);
    if (policy.strictStatusChecks)
      fail(
        "INCOMPLETE",
        "GitHub direct merge cannot atomically condition on the base; strict direct merge is unavailable",
      );
    const after = await core(call, s, r);
    if (JSON.stringify(current) !== JSON.stringify(after))
      fail("INCOMPLETE", "Pull request changed during merge preflight");
    const result = obj(
      await command(
        call,
        s,
        `repos/${r.repository}/pulls/${r.number}/merge`,
        "PUT",
        {
          sha: payload.expectHead,
          merge_method: "squash",
          commit_title: payload.title,
          commit_message: payload.body,
        },
        true,
      ),
    );
    if (result.merged !== true || !sha(result.sha))
      fail(
        "EFFECT_UNCERTAIN",
        "GitHub did not confirm a merge; read and reconcile before retrying",
      );
    return { merged: true, headSha: payload.expectHead, mergeSha: result.sha };
  }
  if (action === "create") {
    const result = obj(
      await command(
        call,
        s,
        `repos/${r.repository}/pulls`,
        "POST",
        {
          title: payload.title,
          body: payload.body,
          head: payload.head,
          base: payload.base,
          draft: payload.draft,
        },
        true,
      ),
    );
    if (
      !Number.isSafeInteger(result.number) ||
      Number(result.number) < 1 ||
      !text(result.html_url) ||
      result.html_url.toLowerCase() !==
        `https://${s.host}/${r.repository}/pull/${Number(result.number)}`.toLowerCase()
    )
      fail(
        "EFFECT_UNCERTAIN",
        "GitHub create response is incomplete; read and reconcile",
      );
    return {
      repository: r.repository,
      number: result.number,
      url: result.html_url,
    };
  }
  const evidence = await gather(call, s, r);
  if (action === "reply" || action === "resolve") {
    if (
      !(evidence.threads as Json[]).some(
        (value) => value.id === payload.threadId,
      )
    )
      fail(
        "INPUT_INVALID",
        "The named thread does not belong to this pull request",
      );
    const query =
      action === "resolve"
        ? "mutation ForgeResolve($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}"
        : "mutation ForgeReply($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id}}}";
    const data = await graphql(
      call,
      s,
      query,
      {
        threadId: payload.threadId,
        ...(action === "reply" ? { body: payload.body } : {}),
      },
      true,
    );
    if (action === "resolve") {
      const thread = obj(obj(data.resolveReviewThread).thread);
      if (thread.id !== payload.threadId || thread.isResolved !== true)
        fail(
          "EFFECT_UNCERTAIN",
          "GitHub did not confirm the named thread resolution",
        );
    } else if (!text(obj(obj(data.addPullRequestReviewThreadReply).comment).id))
      fail("EFFECT_UNCERTAIN", "GitHub did not confirm the review reply");
    return { ...r, threadId: payload.threadId, accepted: true };
  }
  const run = obj(
    await command(
      call,
      s,
      `repos/${r.repository}/actions/runs/${Number(payload.runId)}`,
      "GET",
    ),
  );
  if (
    run.id !== payload.runId ||
    run.head_sha !== evidence.headSha ||
    !Array.isArray(run.pull_requests) ||
    !run.pull_requests.some(
      (value) => object(value) && value.number === r.number,
    )
  )
    fail(
      "INPUT_INVALID",
      "The workflow run does not belong to this pull request head",
    );
  await command(
    call,
    s,
    `repos/${r.repository}/actions/runs/${Number(payload.runId)}/rerun-failed-jobs`,
    "POST",
    {},
    true,
  );
  return { ...r, runId: payload.runId, accepted: true };
}
module.exports = {
  "github.status": async (call: Call) => {
    const s = selected(call);
    await verify(call, s);
    return { account: s.account, host: s.host, available: true };
  },
  "github.use": async (call: Call) => {
    const s = selected(call);
    await verify(call, s);
    return { account: s.account, host: s.host, available: true };
  },
  "github.read": async (call: Call) => {
    const { payload } = protocol(call, false),
      r = ref(payload),
      s = selected(call);
    await verify(call, s);
    return gather(call, s, r);
  },
  "github.call": mutate,
};
