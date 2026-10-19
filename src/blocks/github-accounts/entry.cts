import type { Operations } from "../../contract/author.ts";
import type {
  ProcessService,
  FilesService,
  EnvironmentService,
  CryptoService,
} from "../../assembly/providers.ts";
import type { ProcessResult } from "../../ports/process.ts";
import type {
  ToolCommandPort,
  AccountCommandPort,
} from "../../ports/tool-command.ts";

declare const fail: (code: string, message: string) => never;
interface Config {
  environmentNames: string[];
  gitProgram: string;
  ghProgram: string;
  ghArgs: string[];
  commandTimeoutMs: number;
  maxOutputBytes: number;
  maxFileBytes: number;
  maxCommits: number;
  coauthorPolicy: "allow" | "refuse" | "strip";
  aiCoauthorPatterns: string[];
  forgeCommand: string[];
  shellProgram: string;
  envProgram: string;
  allowedGhCommands: string[];
  identityName: "profile" | "login";
  identityEmail: "noreply" | "primary";
}
interface Services {
  process: ProcessService;
  files: FilesService;
  environment: EnvironmentService;
  crypto: CryptoService;
  repository: ToolCommandPort;
  account: AccountCommandPort;
}
interface Launchers {
  env: string;
  shell: string;
  forge?: string;
}
interface Binding {
  version: 1;
  account: string;
  name: string;
  email: string;
  emails: string[];
  automatic: boolean;
  previous: Record<string, string[]>;
  installed: Record<string, string[]>;
  artifacts: Record<string, string>;
  hooks: boolean;
  launchers?: Launchers;
  hookLaunchers?: Launchers;
}
type Empty = Record<string, never>;
type Bind = {
  login: string;
  name?: string;
  email?: string;
  auto: boolean;
  repository?: string;
};
type Check = { base?: string; tip: string; trigger: "push" | "merge" };
type Message = { text?: string; path?: string };
type Status = {
  bound: boolean;
  account: string | null;
  automatic: boolean;
  identity: { name: string | null; email: string | null };
  mismatches: string[];
  worktrees: {
    path: string;
    name: string | null;
    email: string | null;
    matches: boolean;
  }[];
  routerPath?: string;
};
type AccountOperations = {
  "github-account.bind": readonly [Bind, Status];
  "github-account.unbind": readonly [Empty, { unbound: boolean }];
  "github-account.status": readonly [Empty, Status];
  "github-account.doctor": readonly [Empty, Status];
  "github-account.check": readonly [
    Check,
    { checked: number; trigger: string; tip: string },
  ];
  "github-account.message": readonly [
    Message,
    { text: string; changed: boolean },
  ];
  "github-account.hook": readonly [{ enabled: boolean }, { enabled: boolean }];
  "github-account.run": readonly [
    { args: string[] },
    { exitCode: number; stdout: string },
  ];
};
const DIRECTORY = ".forge-github-accounts";
const META = `${DIRECTORY}/metadata.json`;
const LOCK = `${DIRECTORY}/transaction.lock`;
const STAGING = `${DIRECTORY}/staging.config`;
const STAGING_MARKER = "# forge/github-accounts owned staging v1\n";
const ACCOUNT = "forge.githubAccount";
const HELPER = "credential.https://github.com.helper";
const MARKER = "# forge/github-accounts v1; clone-owned; generated";
const SECRET_NAMES = [
  "gh_token",
  "github_token",
  "gh_enterprise_token",
  "github_enterprise_token",
  "gh_host",
  "gh_repo",
  "git_config_count",
  "git_config_parameters",
  "git_config_global",
  "git_config_system",
  "git_dir",
  "git_work_tree",
  "git_common_dir",
];
function shell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function login(value: string): void {
  if (!/^(?=.{1,39}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value))
    fail("INPUT_INVALID", "Invalid GitHub account login");
}
function cleanIdentity(value: string): void {
  if (!value.trim() || /[\r\n\0<>]/.test(value))
    fail(
      "INPUT_INVALID",
      "Identity must be nonempty and contain no control or angle characters",
    );
}
function repositoryTarget(value: string): string {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
      value,
    );
  if (!match)
    fail(
      "INPUT_INVALID",
      "Repository must identify an owner/repository on github.com",
    );
  return match[1]!;
}
function boundedText(text: string, c: Config): void {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
  }
  if (bytes > c.maxFileBytes)
    fail(
      "ACCOUNT_FILE_LIMIT",
      "Account artifact exceeds the configured file byte limit; raise the declared limit before binding",
    );
}
function envFor(services: Services, config: Config): Record<string, string> {
  const env = { ...services.environment.select(config.environmentNames) };
  for (const key of Object.keys(env))
    if (
      SECRET_NAMES.includes(key.toLowerCase()) ||
      key.toLowerCase().startsWith("git_")
    )
      delete env[key];
  env.GIT_TERMINAL_PROMPT = "0";
  env.GH_PROMPT_DISABLED = "1";
  return env;
}
function context(
  raw: unknown,
  config: unknown,
): { s: Services; c: Config; env: Record<string, string> } {
  const s = raw as Services;
  const c = config as Config;
  if (
    !s?.process ||
    !s.files ||
    !s.environment ||
    !s.crypto ||
    !s.repository ||
    !s.account
  )
    fail(
      "SERVICE_MISSING",
      "GitHub accounts requires repository, account, process, files, environment and crypto services",
    );
  return { s, c, env: envFor(s, c) };
}
function absoluteProgram(path: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path);
}
function pinLaunchers(
  s: Services,
  c: Config,
  env: Record<string, string>,
  hook = false,
): Launchers {
  const pin = (program: string | undefined): string => {
    if (!program)
      fail(
        "ACCOUNT_SHELL_UNAVAILABLE",
        "Configure an available shell and environment launcher before enabling scripts",
      );
    const executable = s.process.resolve(program, env);
    if (executable.kind !== "resolved" || !absoluteProgram(executable.path))
      fail(
        "ACCOUNT_SHELL_UNAVAILABLE",
        "Configured shell or launcher is unavailable; choose an executable before enabling scripts",
      );
    return executable.path;
  };
  return {
    shell: pin(c.shellProgram),
    env: pin(c.envProgram),
    ...(hook ? { forge: pin(c.forgeCommand[0]) } : {}),
  };
}
async function command(
  s: Services,
  c: Config,
  env: Record<string, string>,
  tool: "repository" | "account",
  program: string,
  args: readonly string[],
  cwd = s.files.root,
  allowed: number[] = [0],
  stdin?: string,
): Promise<ProcessResult> {
  const port = s[tool];
  const executable = port.resolve(program, env);
  if (executable.kind !== "resolved")
    fail(
      "PROGRAM_UNAVAILABLE",
      "Required executable is unavailable; configure its executable path",
    );
  let outcome: Awaited<ReturnType<ToolCommandPort["run"]>>;
  try {
    outcome = await port.run(executable.path, args, {
      cwd,
      env,
      timeoutMs: c.commandTimeoutMs,
      maxOutputBytes: c.maxOutputBytes,
      ...(stdin === undefined ? {} : { stdin }),
    });
  } catch {
    return fail(
      "ACCOUNT_COMMAND_FAILED",
      "Account command failed; command output is withheld",
    );
  }
  if ("kind" in outcome)
    fail(
      "PROGRAM_UNAVAILABLE",
      "Required typed command service is unavailable; configure its executable path",
    );
  const result = outcome;
  if (
    result.timedOut ||
    result.truncated ||
    result.exitCode === null ||
    !allowed.includes(result.exitCode)
  )
    fail(
      "ACCOUNT_COMMAND_FAILED",
      "Account command failed or exceeded its configured budget; command output is withheld",
    );
  return result;
}
async function repository(
  s: Services,
  c: Config,
  env: Record<string, string>,
  args: string[],
  cwd?: string,
  allowed?: number[],
): Promise<string> {
  return (
    await command(s, c, env, "repository", c.gitProgram, args, cwd, allowed)
  ).stdout;
}
function parse<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fail(
      "ACCOUNT_DATA_INVALID",
      "Account metadata is invalid; reconcile before retrying",
    );
  }
}
function binding(s: Services, c: Config): Binding | undefined {
  const text = s.files.read(META, c.maxFileBytes, "common");
  if (text === undefined) return undefined;
  const value = parse<Binding>(text);
  if (
    value.version !== 1 ||
    typeof value.account !== "string" ||
    !Array.isArray(value.emails) ||
    !value.emails.every((email) => typeof email === "string") ||
    typeof value.name !== "string" ||
    typeof value.email !== "string" ||
    !value.previous ||
    !value.installed ||
    !value.artifacts
  )
    fail("ACCOUNT_DATA_INVALID", "Invalid clone binding metadata");
  login(value.account);
  return value;
}
async function values(
  s: Services,
  c: Config,
  env: Record<string, string>,
  key: string,
  cwd?: string,
  file?: string,
): Promise<string[]> {
  const output = await command(
    s,
    c,
    env,
    "repository",
    c.gitProgram,
    [
      "config",
      ...(file ? ["--file", file] : ["--local"]),
      "--null",
      "--get-all",
      key,
    ],
    cwd,
    [0, 1],
  );
  return output.exitCode === 1 ? [] : output.stdout.split("\0").slice(0, -1);
}
async function effective(
  s: Services,
  c: Config,
  env: Record<string, string>,
  key: string,
  cwd?: string,
): Promise<string | null> {
  const r = await command(
    s,
    c,
    env,
    "repository",
    c.gitProgram,
    ["config", "--get", key],
    cwd,
    [0, 1],
  );
  return r.exitCode === 1 ? null : r.stdout.trimEnd();
}
function configKey(key: string): string {
  const first = key.indexOf("."),
    last = key.lastIndexOf(".");
  return first === last
    ? key.toLowerCase()
    : key.slice(0, first + 1).toLowerCase() +
        key.slice(first + 1, last) +
        key.slice(last).toLowerCase();
}
function parseConfigValues(text: string): Map<string, string[]> {
  const entries = new Map<string, string[]>();
  if (text === "") return entries;
  if (!text.endsWith("\0"))
    fail("ACCOUNT_DATA_INVALID", "Configuration output is incomplete");
  for (const record of text.slice(0, -1).split("\0")) {
    const separator = record.indexOf("\n"),
      key = configKey(separator < 0 ? record : record.slice(0, separator));
    if (!key)
      fail("ACCOUNT_DATA_INVALID", "Configuration output has an empty key");
    const value = separator < 0 ? "" : record.slice(separator + 1),
      values = entries.get(key) ?? [];
    values.push(value);
    entries.set(key, values);
  }
  return entries;
}
async function configValues(
  s: Services,
  c: Config,
  env: Record<string, string>,
  keys: readonly string[],
  local = false,
  cwd?: string,
): Promise<Map<string, string[]>> {
  if (keys.length === 0) return new Map();
  const pattern =
    "^(" +
    [...new Set(keys.map(configKey))]
      .map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|") +
    ")$";
  const result = await command(
    s,
    c,
    env,
    "repository",
    c.gitProgram,
    [
      "config",
      ...(local ? ["--local"] : []),
      "--null",
      "--get-regexp",
      pattern,
    ],
    cwd,
    [0, 1],
  );
  return parseConfigValues(result.stdout);
}
function lastConfigValue(
  entries: ReadonlyMap<string, readonly string[]>,
  key: string,
): string | null {
  return entries.get(configKey(key))?.at(-1)?.trimEnd() ?? null;
}
async function stageConfig(
  s: Services,
  c: Config,
  env: Record<string, string>,
  original: string,
  changes: Record<string, string[]>,
): Promise<string> {
  const path = STAGING;
  const previous = s.files.read(path, c.maxFileBytes, "common");
  if (previous !== undefined) {
    if (!previous.startsWith(STAGING_MARKER))
      fail(
        "INPUT_CONFLICT",
        "Foreign account staging file exists; reconcile before retrying",
      );
    s.files.remove(path, { area: "common", expected: previous });
  }
  const initial = STAGING_MARKER + original;
  boundedText(initial, c);
  s.files.write(path, initial, { area: "common", expected: null });
  const absolute = `${s.files.roots.common}/${path}`;
  try {
    for (const [key, list] of Object.entries(changes)) {
      await repository(
        s,
        c,
        env,
        ["config", "--file", absolute, "--unset-all", key],
        undefined,
        [0, 5],
      );
      for (const value of list)
        await repository(s, c, env, [
          "config",
          "--file",
          absolute,
          "--add",
          key,
          value,
        ]);
    }
    const text = s.files.read(path, c.maxFileBytes, "common");
    if (text === undefined || !text.startsWith(STAGING_MARKER))
      fail(
        "INPUT_CONFLICT",
        "Staged configuration disappeared or its ownership marker changed",
      );
    return text.slice(STAGING_MARKER.length);
  } finally {
    const current = s.files.read(path, c.maxFileBytes, "common");
    if (current !== undefined) {
      if (!current.startsWith(STAGING_MARKER))
        fail(
          "INPUT_CONFLICT",
          "Staging ownership marker changed; reconcile before retrying",
        );
      s.files.remove(path, { area: "common", expected: current });
    }
  }
}
async function transaction<T>(
  s: Services,
  action: () => Promise<T>,
): Promise<T> {
  const owned = s.files.lock([LOCK]);
  try {
    return await action();
  } finally {
    owned.release();
  }
}
async function authenticate(
  s: Services,
  c: Config,
  env: Record<string, string>,
  account: string,
): Promise<{
  env: Record<string, string>;
  user: { login: string; id: number; name?: string };
}> {
  login(account);
  const result = await command(s, c, env, "account", c.ghProgram, [
    ...c.ghArgs,
    "auth",
    "token",
    "--hostname",
    "github.com",
    "--user",
    account,
  ]);
  const token = result.stdout.trim();
  if (!token || /[\r\n\0]/.test(token))
    fail("ACCOUNT_AUTH_FAILED", "Stored GitHub credential is unavailable");
  const child = { ...env, GH_TOKEN: token, GH_HOST: "github.com" };
  const response = await command(s, c, child, "account", c.ghProgram, [
    ...c.ghArgs,
    "api",
    "user",
    "--hostname",
    "github.com",
  ]);
  const user = parse<{ login: string; id: number; name?: string }>(
    response.stdout,
  );
  if (
    typeof user.login !== "string" ||
    user.login.toLowerCase() !== account.toLowerCase() ||
    !Number.isSafeInteger(user.id) ||
    user.id <= 0 ||
    (user.name !== undefined &&
      user.name !== null &&
      typeof user.name !== "string")
  )
    fail(
      "ACCOUNT_MISMATCH",
      "Stored credential does not authenticate as the selected account",
    );
  return { env: child, user };
}
function allowedCommand(args: readonly string[], c: Config): void {
  if (
    args.length < 2 ||
    !c.allowedGhCommands.includes(`${args[0]} ${args[1]}`) ||
    ["auth", "alias", "config", "extension", "secret"].includes(args[0] ?? "")
  )
    fail(
      "ACCOUNT_COMMAND_REFUSED",
      "Command is not configured for safe account routing",
    );
  if (
    args.some((value) => /[\0\r\n]/.test(value)) ||
    args.some((value) =>
      /^(?:--hostname|--repo|--header)(?:=|$)|^-[RH]/.test(value),
    )
  )
    fail(
      "ACCOUNT_COMMAND_REFUSED",
      "Host, identity and repository overrides are not accepted by the account router",
    );
}
function checkRef(ref: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_./~^@{}+-]*$/.test(ref) || ref.includes(".."))
    fail("INPUT_INVALID", "Invalid commit reference");
}
function policy(
  text: string,
  c: Pick<Config, "coauthorPolicy" | "aiCoauthorPatterns">,
): { text: string; changed: boolean } {
  const normalized = text.replace(/\r\n/g, "\n"),
    trimmed = normalized.replace(/\s+$/, ""),
    separator = trimmed.lastIndexOf("\n\n"),
    start = separator < 0 ? 0 : separator + 2;
  const prefix = trimmed.slice(0, start),
    lines = trimmed.slice(start).split("\n");
  const groups: { key: string; lines: string[] }[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && groups.length) {
      groups[groups.length - 1]!.lines.push(line);
      continue;
    }
    const match = /^([A-Za-z0-9-]+)\s*:/.exec(line);
    if (!match) return { text, changed: false };
    groups.push({ key: match[1]!.toLowerCase(), lines: [line] });
  }
  const matches = groups.map(
    (group) =>
      group.key === "co-authored-by" &&
      c.aiCoauthorPatterns.some((pattern) =>
        group.lines.join(" ").toLowerCase().includes(pattern.toLowerCase()),
      ),
  );
  if (c.coauthorPolicy === "allow" || !matches.some(Boolean))
    return { text, changed: false };
  if (c.coauthorPolicy === "refuse")
    fail(
      "AI_COAUTHOR_REFUSED",
      "Commit message contains a refused AI co-author trailer",
    );
  const remaining = groups
    .filter((_group, index) => !matches[index])
    .flatMap((group) => group.lines);
  const result = (prefix + remaining.join("\n")).trimEnd() + "\n";
  return {
    text: text.includes("\r\n") ? result.replace(/\n/g, "\r\n") : result,
    changed: true,
  };
}
async function status(
  s: Services,
  c: Config,
  env: Record<string, string>,
): Promise<Status> {
  const bound = binding(s, c),
    configured = await configValues(s, c, env, [
      ACCOUNT,
      "user.name",
      "user.email",
    ]),
    account = lastConfigValue(configured, ACCOUNT),
    identity = {
      name: lastConfigValue(configured, "user.name"),
      email: lastConfigValue(configured, "user.email"),
    };
  const mismatches: string[] = [];
  const worktrees: Status["worktrees"] = [];
  if (
    Boolean(bound) !== Boolean(account) ||
    (bound && account !== bound.account)
  )
    mismatches.push("binding");
  if (
    bound &&
    (identity.name !== bound.name ||
      !bound.emails.includes((identity.email ?? "").toLowerCase()))
  )
    mismatches.push("identity");
  if (bound)
    for (const [path, text] of Object.entries(bound.artifacts)) {
      const info = s.files.inspect(path, "common");
      if (
        s.files.read(path, c.maxFileBytes, "common") !== text ||
        (s.environment.platform !== "win32" && !info?.executable)
      )
        mismatches.push(`artifact:${path}`);
    }
  if (bound) {
    const local = await configValues(
      s,
      c,
      env,
      Object.keys(bound.installed),
      true,
    );
    for (const [key, wanted] of Object.entries(bound.installed))
      if (!same(local.get(configKey(key)) ?? [], wanted))
        mismatches.push(`config:${key}`);
  }
  const output = await repository(s, c, env, [
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  const pathKey = (path: string): string =>
    path.replace(/\\/g, "/").replace(/\/+$/, "");
  for (const record of output.split("\0\0")) {
    const path = record
      .split("\0")
      .find((line) => line.startsWith("worktree "))
      ?.slice(9);
    if (!path) continue;
    const selected =
      pathKey(path) === pathKey(s.files.root)
        ? identity
        : await configValues(
            s,
            c,
            env,
            ["user.name", "user.email"],
            false,
            path,
          ).then((entries) => ({
            name: lastConfigValue(entries, "user.name"),
            email: lastConfigValue(entries, "user.email"),
          }));
    const { name, email } = selected;
    worktrees.push({
      path,
      name,
      email,
      matches:
        !bound ||
        (name === bound.name &&
          bound.emails.includes((email ?? "").toLowerCase())),
    });
    if (bound && !worktrees[worktrees.length - 1]!.matches)
      mismatches.push(`worktree:${path}`);
  }
  return {
    bound: !!bound,
    account: bound?.account ?? null,
    automatic: bound?.automatic ?? false,
    identity,
    mismatches,
    worktrees,
    ...(bound?.automatic
      ? { routerPath: `${s.files.roots.common}/${DIRECTORY}/bin` }
      : {}),
  };
}
async function check(
  s: Services,
  c: Config,
  env: Record<string, string>,
  input: Check,
): Promise<{ checked: number; trigger: string; tip: string }> {
  const bound = binding(s, c);
  if (!bound)
    fail(
      "ACCOUNT_UNBOUND",
      "Choose an account before checking commit identity",
    );
  if ((await effective(s, c, env, ACCOUNT)) !== bound.account)
    fail(
      "ACCOUNT_MISMATCH",
      "Clone account metadata and configuration disagree",
    );
  checkRef(input.tip);
  if (input.base) checkRef(input.base);
  const tip = (
    await repository(s, c, env, [
      "rev-parse",
      "--verify",
      `${input.tip}^{commit}`,
    ])
  ).trim();
  const base =
    input.base && !/^0+$/.test(input.base)
      ? (
          await repository(s, c, env, [
            "rev-parse",
            "--verify",
            `${input.base}^{commit}`,
          ])
        ).trim()
      : undefined;
  const revs = (
    await repository(s, c, env, [
      "rev-list",
      tip,
      ...(base ? [`^${base}`] : []),
    ])
  )
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  if (revs.length > c.maxCommits)
    fail(
      "ACCOUNT_COMMIT_LIMIT",
      "Commit range exceeds configured cap; increase the declared limit or narrow the range",
    );
  for (const revision of revs) {
    const author = (
      await repository(s, c, env, [
        "show",
        "-s",
        "--format=%ae%x00%ce%x00%B",
        revision,
      ])
    ).split("\0");
    if (
      !bound.emails.includes((author[0] ?? "").trim().toLowerCase()) ||
      !bound.emails.includes((author[1] ?? "").trim().toLowerCase())
    )
      fail(
        "ACCOUNT_IDENTITY_MISMATCH",
        "Commit author or committer email does not belong to the bound account; amend before continuing",
      );
    const result = policy(author.slice(2).join("\0"), c);
    if (result.changed)
      fail(
        "AI_COAUTHOR_REFUSED",
        "Existing commit contains an AI co-author trailer; amend its message before continuing",
      );
  }
  if (
    (
      await repository(s, c, env, [
        "rev-parse",
        "--verify",
        `${input.tip}^{commit}`,
      ])
    ).trim() !== tip
  )
    fail(
      "INPUT_CONFLICT",
      "Commit tip changed during identity check; retry against a fixed commit",
    );
  return { checked: revs.length, trigger: input.trigger, tip };
}
interface HookRoute {
  worktree: string;
  scope: string | null;
  override: string | null;
  hook: string;
}
function hookPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}
async function hookRoutes(
  s: Services,
  c: Config,
  env: Record<string, string>,
): Promise<HookRoute[]> {
  const listed = await repository(s, c, env, [
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  const routes: HookRoute[] = [];
  for (const record of listed.split("\0\0")) {
    const worktree = record
      .split("\0")
      .find((line) => line.startsWith("worktree "))
      ?.slice(9);
    if (!worktree) continue;
    const configured = await command(
      s,
      c,
      env,
      "repository",
      c.gitProgram,
      ["config", "--null", "--show-scope", "--get", "core.hooksPath"],
      worktree,
      [0, 1],
    );
    const parts = configured.stdout.split("\0");
    if (configured.exitCode === 0 && (parts.length !== 3 || parts[2] !== ""))
      fail(
        "ACCOUNT_DATA_INVALID",
        "Effective hook configuration is incomplete",
      );
    const resolved = await command(
      s,
      c,
      env,
      "repository",
      c.gitProgram,
      ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-push"],
      worktree,
      [0, 1, 128],
    );
    if (resolved.exitCode !== 0)
      fail(
        configured.exitCode === 0
          ? parts[0] === "worktree"
            ? "ACCOUNT_HOOKS_CONFLICT"
            : "INPUT_CONFLICT"
          : "ACCOUNT_COMMAND_FAILED",
        `Cannot resolve guard hooks in worktree ${worktree}: core.hooksPath=${JSON.stringify(configured.exitCode === 0 ? parts[1] : null)}`,
      );
    routes.push({
      worktree,
      scope: configured.exitCode === 0 ? parts[0]! : null,
      override: configured.exitCode === 0 ? parts[1]! : null,
      hook: hookPath(resolved.stdout.replace(/\r?\n$/, "")),
    });
  }
  if (!routes.length)
    fail(
      "ACCOUNT_DATA_INVALID",
      "Git returned no worktrees for guard verification",
    );
  return routes;
}
function verifyHookRoutes(
  routes: readonly HookRoute[],
  expected: string,
  enabled: boolean,
): void {
  for (const route of routes)
    if (route.hook !== expected && (enabled || route.override !== null))
      fail(
        enabled || route.scope === "worktree"
          ? "ACCOUNT_HOOKS_CONFLICT"
          : "INPUT_CONFLICT",
        `Guard hook conflict in worktree ${route.worktree}: core.hooksPath=${JSON.stringify(route.override)} resolves to ${route.hook}; expected ${expected}`,
      );
}
function hookScript(c: Config, launchers: Launchers, s: Services): string {
  const call = [launchers.forge!, ...c.forgeCommand.slice(1)]
    .map(shell)
    .join(" ");
  const body = `set -eu\nwhile read -r local_ref local_sha remote_ref remote_sha; do\n case "$local_sha" in 0000000000000000000000000000000000000000|0000000000000000000000000000000000000000000000000000000000000000) continue;; esac\n case "$local_sha$remote_sha" in *[!0-9a-fA-F]*) exit 1;; esac\n if output=$(${call} github-account check --input "{\\"tip\\":\\"$local_sha\\",\\"base\\":\\"$remote_sha\\",\\"trigger\\":\\"push\\"}"); then :; else printf '%s\\n' "$output" >&2; exit 1; fi\ndone\n`;
  return s.account.bootstrap({
    body,
    envPath: launchers.env,
    shellPath: launchers.shell,
    environmentNames: c.environmentNames,
    marker: MARKER,
    windows: s.environment.platform === "win32",
  });
}
const operations: Operations<AccountOperations> = {
  async "github-account.bind"({ input, services, config }) {
    const { s, c, env } = context(services, config);
    login(input.login);
    const launchers = input.auto ? pinLaunchers(s, c, env) : undefined;
    const auth = await authenticate(s, c, env, input.login);
    const emailsResult = await command(s, c, auth.env, "account", c.ghProgram, [
      ...c.ghArgs,
      "api",
      "user/emails",
      "--hostname",
      "github.com",
    ]);
    const response = parse<unknown>(emailsResult.stdout);
    if (!Array.isArray(response))
      fail("ACCOUNT_DATA_INVALID", "Verified email response was invalid");
    const verified = (response as unknown[]).filter(
      (value): value is { email: string; verified: true; primary?: boolean } =>
        typeof value === "object" &&
        value !== null &&
        "email" in value &&
        typeof value.email === "string" &&
        "verified" in value &&
        value.verified === true,
    );
    const emails = verified.map((value) => value.email.toLowerCase());
    const noreply =
      `${auth.user.id}+${auth.user.login}@users.noreply.github.com`.toLowerCase();
    emails.push(noreply);
    const selectedEmail =
      c.identityEmail === "noreply"
        ? noreply
        : verified.find((value) => value.primary === true)?.email;
    if (!input.email && !selectedEmail)
      fail(
        "ACCOUNT_EMAIL_UNVERIFIED",
        "Account has no verified primary email; choose a verified email or noreply in configuration",
      );
    const email = (input.email ?? selectedEmail!).toLowerCase(),
      name =
        input.name ??
        (c.identityName === "login"
          ? auth.user.login
          : (auth.user.name ?? auth.user.login));
    cleanIdentity(name);
    cleanIdentity(email);
    if (!emails.includes(email))
      fail(
        "ACCOUNT_EMAIL_UNVERIFIED",
        "Chosen commit email is not verified for the selected account",
      );
    let targetRepository = input.repository;
    if (!targetRepository)
      targetRepository = (
        await repository(s, c, env, ["remote", "get-url", "origin"])
      ).trim();
    if (
      !targetRepository ||
      targetRepository.startsWith("-") ||
      /[\0\r\n]/.test(targetRepository)
    )
      fail(
        "INPUT_INVALID",
        "Repository must identify the target GitHub repository",
      );
    await command(s, c, auth.env, "account", c.ghProgram, [
      ...c.ghArgs,
      "repo",
      "view",
      repositoryTarget(targetRepository),
      "--json",
      "nameWithOwner",
    ]);
    await transaction(s, async () => {
      if (binding(s, c))
        fail(
          "ACCOUNT_ALREADY_BOUND",
          "Unbind the current account before choosing another",
        );
      const original = s.files.read("config", c.maxFileBytes, "common");
      if (original === undefined)
        fail("ACCOUNT_CONFIG_MISSING", "Clone Git configuration is missing");
      if ((await values(s, c, env, ACCOUNT)).length)
        fail(
          "INPUT_CONFLICT",
          "Account configuration exists without owned metadata; reconcile it first",
        );
      const artifacts: Record<string, string> = {};
      const installed: Record<string, string[]> = {
        [ACCOUNT]: [auth.user.login],
        "user.name": [name],
        "user.email": [email],
      };
      if (input.auto) {
        const routerPath = `${DIRECTORY}/bin/gh`,
          helperPath = `${DIRECTORY}/credential-helper`;
        const nativeGh = s.account.resolve(c.ghProgram, env),
          nativeGit = s.repository.resolve(c.gitProgram, env);
        if (
          nativeGh.kind !== "resolved" ||
          nativeGit.kind !== "resolved" ||
          !absoluteProgram(nativeGh.path) ||
          !absoluteProgram(nativeGit.path)
        )
          fail(
            "PROGRAM_UNAVAILABLE",
            "Native GitHub and Git executable paths must resolve before installing routing",
          );
        const windows = s.environment.platform === "win32";
        const scripts = s.account.scripts({
          account: auth.user.login,
          gitPath: nativeGit.path,
          ghPath: nativeGh.path,
          ghArgs: c.ghArgs,
          envPath: launchers!.env,
          shellPath: launchers!.shell,
          environmentNames: c.environmentNames,
          allowedGhCommands: c.allowedGhCommands,
          accountKey: ACCOUNT,
          marker: MARKER,
          windows,
        });
        artifacts[routerPath] = scripts.router;
        artifacts[helperPath] = scripts.credential;
        installed[HELPER] = [
          "",
          `!${shell(`${s.files.roots.common}/${helperPath}`)}`,
        ];
      }
      const previous: Record<string, string[]> = {};
      for (const key of Object.keys(installed))
        previous[key] = await values(s, c, env, key);
      const replacement = await stageConfig(s, c, env, original, installed);
      const bound: Binding = {
        version: 1,
        account: auth.user.login,
        name,
        email,
        emails: [...new Set(emails)],
        automatic: input.auto,
        previous,
        installed,
        artifacts,
        hooks: false,
        ...(launchers ? { launchers } : {}),
      };
      const written: string[] = [];
      let metadata: string | undefined;
      for (const text of Object.values(artifacts)) boundedText(text, c);
      boundedText(JSON.stringify(bound), c);
      try {
        for (const [path, text] of Object.entries(artifacts)) {
          s.files.write(path, text, {
            area: "common",
            expected: null,
            executable: true,
          });
          written.push(path);
        }
        metadata = JSON.stringify(bound);
        s.files.write(META, metadata, { area: "common", expected: null });
        s.files.write("config", replacement, {
          area: "common",
          expected: original,
        });
      } catch (error) {
        if (
          metadata &&
          s.files.read(META, c.maxFileBytes, "common") === metadata
        )
          s.files.remove(META, { area: "common", expected: metadata });
        for (const path of written.reverse())
          s.files.remove(path, { area: "common", expected: artifacts[path]! });
        throw error;
      }
    });
    return status(s, c, env);
  },
  async "github-account.unbind"({ services, config }) {
    const { s, c, env } = context(services, config);
    return transaction(s, async () => {
      const bound = binding(s, c);
      if (!bound) return { unbound: true };
      const metadata = s.files.read(META, c.maxFileBytes, "common")!;
      const current: Record<string, string[]> = {};
      for (const key of Object.keys(bound.installed))
        current[key] = await values(s, c, env, key);
      const installed = Object.entries(bound.installed).every(([key, wanted]) =>
        same(current[key], wanted),
      );
      const previous = Object.entries(bound.previous).every(([key, wanted]) =>
        same(current[key], wanted),
      );
      if (!installed && !previous)
        fail(
          "INPUT_CONFLICT",
          "Clone settings changed after binding; reconcile before unbinding",
        );
      for (const [path, text] of Object.entries(bound.artifacts)) {
        const actual = s.files.read(path, c.maxFileBytes, "common");
        if (actual !== undefined && actual !== text)
          fail(
            "INPUT_CONFLICT",
            "Owned account artifact changed; reconcile before unbinding",
          );
      }
      const original = s.files.read("config", c.maxFileBytes, "common")!;
      if (installed) {
        const replacement = await stageConfig(
          s,
          c,
          env,
          original,
          bound.previous,
        );
        s.files.write("config", replacement, {
          area: "common",
          expected: original,
        });
      }
      for (const [path, text] of Object.entries(bound.artifacts))
        if (s.files.read(path, c.maxFileBytes, "common") !== undefined)
          s.files.remove(path, { area: "common", expected: text });
      s.files.remove(META, { area: "common", expected: metadata });
      return { unbound: true };
    });
  },
  async "github-account.status"({ services, config }) {
    const { s, c, env } = context(services, config);
    return status(s, c, env);
  },
  async "github-account.doctor"({ services, config }) {
    const { s, c, env } = context(services, config);
    const result = await status(s, c, env);
    if (result.account)
      try {
        await authenticate(s, c, env, result.account);
      } catch {
        result.mismatches.push("authentication");
      }
    return result;
  },
  async "github-account.check"({ input, services, config }) {
    const { s, c, env } = context(services, config);
    return check(s, c, env, input);
  },
  "github-account.message"({ input, services, config }) {
    const c = config as Config;
    if (input.text !== undefined && input.path !== undefined)
      fail("INPUT_INVALID", "Choose message text or a message file");
    if (input.path === undefined) {
      if (input.text === undefined)
        fail("INPUT_INVALID", "Message text or path is required");
      return policy(input.text, c);
    }
    const { s } = context(services, config);
    let path = input.path.replace(/\\/g, "/");
    const root = s.files.roots.git.replace(/\\/g, "/");
    if (path.startsWith(root + "/")) path = path.slice(root.length + 1);
    const text = s.files.read(path, c.maxFileBytes, "git");
    if (text === undefined)
      fail("NOT_FOUND", "Commit message file was not found");
    const result = policy(text, c);
    if (result.changed)
      s.files.write(path, result.text, { area: "git", expected: text });
    return result;
  },
  async "github-account.hook"({ input, services, config }) {
    const { s, c, env } = context(services, config);
    const launchers = input.enabled ? pinLaunchers(s, c, env, true) : undefined;
    return transaction(s, async () => {
      const bound = binding(s, c);
      if (!bound)
        fail(
          "ACCOUNT_UNBOUND",
          "Choose an account before installing its guard",
        );
      const expectedHook = hookPath(
        `${s.files.roots.common}/${DIRECTORY}/hooks/pre-push`,
      );
      const routes = input.enabled ? await hookRoutes(s, c, env) : [];
      if (input.enabled) verifyHookRoutes(routes, expectedHook, bound.hooks);
      if (bound.hooks === input.enabled) return { enabled: input.enabled };
      const metadata = s.files.read(META, c.maxFileBytes, "common")!;
      const key = "core.hooksPath",
        path = `${DIRECTORY}/hooks/pre-push`,
        text = launchers ? hookScript(c, launchers, s) : "";
      const original = s.files.read("config", c.maxFileBytes, "common")!;
      if (input.enabled) {
        const common = hookPath(s.files.roots.common);
        const hookNames = [
          "applypatch-msg",
          "pre-applypatch",
          "post-applypatch",
          "pre-commit",
          "pre-merge-commit",
          "prepare-commit-msg",
          "commit-msg",
          "post-commit",
          "pre-rebase",
          "post-checkout",
          "post-merge",
          "pre-push",
          "pre-receive",
          "update",
          "proc-receive",
          "post-receive",
          "post-update",
          "reference-transaction",
          "push-to-checkout",
          "pre-auto-gc",
          "post-rewrite",
          "sendemail-validate",
          "fsmonitor-watchman",
          "p4-changelist",
          "p4-prepare-changelist",
          "p4-post-changelist",
          "p4-pre-submit",
          "post-index-change",
        ];
        for (const nativePath of new Set(routes.map((route) => route.hook))) {
          if (nativePath.startsWith(common + "/")) {
            const directory = nativePath.slice(
              common.length + 1,
              -"pre-push".length,
            );
            if (
              hookNames.some((name) =>
                s.files.inspect(directory + name, "common"),
              )
            )
              fail(
                "INPUT_CONFLICT",
                "An existing native hook is present; integrate the catalog check there",
              );
          } else
            fail(
              "INPUT_CONFLICT",
              "Cannot establish ownership of the clone's native hook directory",
            );
        }
        bound.previous[key] = await values(s, c, env, key);
        bound.installed[key] = [`${s.files.roots.common}/${DIRECTORY}/hooks`];
        bound.artifacts[path] = text;
        const replacement = await stageConfig(s, c, env, original, {
          [key]: bound.installed[key],
        });
        bound.hooks = true;
        bound.hookLaunchers = launchers!;
        const updated = JSON.stringify(bound);
        boundedText(updated, c);
        boundedText(text, c);
        s.files.write(path, text, {
          area: "common",
          expected: null,
          executable: true,
        });
        let published = false;
        try {
          s.files.write(META, updated, { area: "common", expected: metadata });
          s.files.write("config", replacement, {
            area: "common",
            expected: original,
          });
          published = true;
          verifyHookRoutes(await hookRoutes(s, c, env), expectedHook, true);
        } catch (error) {
          if (published)
            s.files.write("config", original, {
              area: "common",
              expected: replacement,
            });
          if (s.files.read(META, c.maxFileBytes, "common") === updated)
            s.files.write(META, metadata, {
              area: "common",
              expected: updated,
            });
          s.files.remove(path, { area: "common", expected: text });
          throw error;
        }
      } else {
        if (
          !same(await values(s, c, env, key), bound.installed[key]) ||
          s.files.read(path, c.maxFileBytes, "common") !== bound.artifacts[path]
        )
          fail(
            "INPUT_CONFLICT",
            "Guard settings changed; reconcile before removing",
          );
        const replacement = await stageConfig(s, c, env, original, {
          [key]: bound.previous[key]!,
        });
        const owned = bound.artifacts[path]!;
        delete bound.previous[key];
        delete bound.installed[key];
        delete bound.artifacts[path];
        bound.hooks = false;
        delete bound.hookLaunchers;
        const updated = JSON.stringify(bound);
        boundedText(updated, c);
        s.files.write(META, updated, { area: "common", expected: metadata });
        try {
          s.files.write("config", replacement, {
            area: "common",
            expected: original,
          });
        } catch (error) {
          s.files.write(META, metadata, { area: "common", expected: updated });
          throw error;
        }
        s.files.remove(path, { area: "common", expected: owned });
      }
      return { enabled: input.enabled };
    });
  },
  async "github-account.run"({ input, services, config }) {
    const { s, c, env } = context(services, config);
    allowedCommand(input.args, c);
    const bound = binding(s, c);
    if (!bound)
      fail("ACCOUNT_UNBOUND", "Choose an account before routed commands");
    if ((await effective(s, c, env, ACCOUNT)) !== bound.account)
      fail("ACCOUNT_MISMATCH", "Clone binding does not match its metadata");
    const auth = await authenticate(s, c, env, bound.account);
    const result = await command(s, c, auth.env, "account", c.ghProgram, [
      ...c.ghArgs,
      ...input.args,
    ]);
    if (result.stdout.includes(auth.env.GH_TOKEN!))
      fail(
        "ACCOUNT_OUTPUT_REFUSED",
        "Command output contained credential material and was withheld",
      );
    return { exitCode: result.exitCode!, stdout: result.stdout };
  },
};
module.exports = operations;
