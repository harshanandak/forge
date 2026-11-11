import type { ProcessPort, ResolvedExecutable } from "../../ports/process.ts";
import type { DeviceFiles, ExecutablePin } from "../../ports/device-files.ts";
declare const fail: (...args: [string, string, { repair?: string }?]) => never;
interface Files {
  root: string;
  read(path: string, max: number, area?: "common"): string | undefined;
  write(
    path: string,
    text: string,
    options: { area: "common"; expected: string | null },
  ): void;
  lock(paths: readonly string[]): { release(): void };
}
interface Services {
  process: ProcessPort;
  files: Files;
  device: DeviceFiles;
  environment: {
    platform: NodeJS.Platform;
    inherit(): Readonly<Record<string, string>>;
    select(names: readonly string[]): Readonly<Record<string, string>>;
  };
  crypto: { sha256(text: string): string; randomUUID(): string };
}
interface Account {
  login: string;
  userId: number;
  commitName: string;
  commitEmails: string[];
  gh: ExecutablePin;
}
interface Binding {
  login?: string;
  fingerprint?: string;
  appliedFrom: string;
  declined?: boolean;
}
interface Applied {
  repo: string;
  fingerprint: string;
  includeHash: string;
  appliedFrom: string;
}
interface Input {
  login?: string;
  approval?: { quote: string; source: string };
  base?: string;
  tip?: string;
}
interface Call {
  input: Input;
  services: Services;
  config?: { maxCommits?: number };
}
interface ApprovalRecord {
  id?: string;
  repo?: string;
  kind?: string;
  fingerprint?: string;
  approval?: { quote?: string; source?: string };
}
const LIMIT = 1048576,
  MAX_COMMITS = 500,
  REF = /^[A-Za-z0-9_][A-Za-z0-9._/@{}^~-]{0,255}$/,
  OWNED = "forge/accounts.gitconfig",
  MARK = "# forge accounts owned include";
function refuse(code: string, message: string): never {
  if (typeof fail === "function") return fail(code, message);
  throw Object.assign(new Error(message), { code });
}
function parse<T>(text: string | undefined, fallback: T): T {
  if (text === undefined) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return refuse("ACCOUNT_INTEGRITY", "Invalid accounts record");
  }
}
function parseObject<T extends object>(
  text: string | undefined,
  fallback: T,
): T {
  const value = parse<unknown>(text, fallback);
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return refuse(
      "ACCOUNT_INTEGRITY",
      "Accounts record must be a plain object",
    );
  return value as T;
}
async function contact(
  { input, services: s, config: settings }: Call,
  action: "plan" | "use" | "decline" | "check",
) {
  if (
    (action === "use" || action === "decline") &&
    (!input.approval?.quote?.trim() || !input.approval.source?.trim())
  )
    refuse(
      "APPROVAL_REQUIRED",
      "Relay the owner's chat reply with approval: {quote, source}",
    );
  const ambient: Record<string, string> = {
    ...s.environment.select([
      "PATH",
      "PATHEXT",
      "HOME",
      "USERPROFILE",
      "SYSTEMROOT",
      "SystemRoot",
      "COMSPEC",
      "TEMP",
      "TMP",
      "TMPDIR",
      "LANG",
      "TERM",
      "TZ",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "NO_PROXY",
    ]),
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
  const excluded = [
    s.files.root,
    ambient.TEMP ?? "",
    ambient.TMP ?? "",
    ambient.TMPDIR ?? "/tmp",
  ];
  const pathKey =
    Object.keys(ambient).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const separator = s.environment.platform === "win32" ? ";" : ":";
  // The first PATH entry that is not a project, temp, relative or work-tree directory wins.
  function trusted(name: string): ExecutablePin | undefined {
    for (const directory of (ambient[pathKey] ?? "").split(separator)) {
      const candidate = s.process.resolve(name, {
        ...ambient,
        [pathKey]: directory,
      });
      if (candidate.kind !== "resolved") continue;
      try {
        return s.device.pin(candidate.path, excluded);
      } catch {
        /* Skip untrusted search entries before spawning. */
      }
    }
    return undefined;
  }
  const gitPin = trusted("git");
  if (!gitPin) refuse("UNAVAILABLE", "Accounts requires Git");
  const git: ResolvedExecutable = { kind: "resolved", path: gitPin.path };
  // Children see only the pinned git's directory, never the caller's PATH.
  const env: Record<string, string> = {
    ...ambient,
    [pathKey]: gitPin.path.replace(/[\\/][^\\/]*$/, ""),
  };
  async function run(
    exe: ResolvedExecutable,
    args: string[],
    optional = false,
    childEnv = env,
    spawn: { sensitive?: boolean; redact?: readonly string[] } = {},
  ) {
    const out = await s.process.run(exe, args, {
      cwd: s.files.root,
      env: childEnv,
      timeoutMs: 10000,
      maxOutputBytes: LIMIT,
      ...spawn,
    });
    if (out.timedOut || out.truncated || (out.exitCode !== 0 && !optional))
      refuse(
        "ACCOUNT_UNAVAILABLE",
        "Account operation failed; verify the binding before continuing",
      );
    return {
      ok: out.exitCode === 0,
      text: out.stdout.trim(),
      raw: out.stdout,
      error: out.stderr,
    };
  }
  const g = async (args: string[], optional = false) =>
    run(git, ["-c", "core.fsmonitor=false", ...args], optional);
  const remote = (await g(["remote", "get-url", "origin"], true)).text;
  const match =
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      remote,
    );
  if (remote && !match)
    refuse("ACCOUNT_HOST_UNSUPPORTED", "Only github.com origins are supported");
  // Only a repo without a github.com origin is named by its common git dir.
  const repo = match
    ? `github.com/${match[1]}/${match[2]}`.toLowerCase()
    : `local:${(await g(["rev-parse", "--path-format=absolute", "--git-common-dir"])).text}`;
  const bindingText = s.device.read("bindings.json"),
    accountText = s.device.read("accounts.json");
  const bindings = parseObject<Record<string, Binding>>(bindingText, {});
  const accounts = parseObject<Record<string, Account>>(accountText, {});
  const binding = Object.hasOwn(bindings, repo) ? bindings[repo] : undefined;
  const integrity = (message: string): never =>
    refuse("ACCOUNT_INTEGRITY", message);
  const hash = (value: unknown) => s.crypto.sha256(JSON.stringify(value));
  const includeFor = (account: Account) => ({
    content: `# forge accounts ${hash(account)}\n[user]\n\tname = ${JSON.stringify(account.commitName)}\n\temail = ${JSON.stringify(account.commitEmails[0])}\n\tuseConfigOnly = true\n`,
    include: `${MARK}\n[include]\n\tpath = "forge/accounts.gitconfig"\n# end forge accounts owned include\n`,
  });
  function recover(locked = false): void {
    if (action === "decline") return;
    const paths = [OWNED, "forge/accounts.applied.json", "config"];
    const [content, record, configText] = paths.map((path) =>
      s.files.read(path, LIMIT, "common"),
    );
    const current = configText ?? "";
    const marked = current.includes(MARK);
    if (content === undefined && record === undefined && !marked) return;
    if (action !== "check" && !locked) {
      const deviceLock = s.device.lock();
      try {
        const lease = s.files.lock(["forge/accounts.apply.lock"]);
        try {
          if (
            s.device.read("bindings.json") !== bindingText ||
            s.device.read("accounts.json") !== accountText
          )
            refuse("INPUT_CONFLICT", "Accounts changed; plan again");
          return recover(true);
        } finally {
          lease.release();
        }
      } finally {
        deviceLock.release();
      }
    }
    const message =
      "Owned include has no matching device binding or clone record";
    const account =
      binding?.login && Object.hasOwn(accounts, binding.login)
        ? accounts[binding.login]
        : undefined;
    if (
      !binding ||
      binding.declined ||
      !account ||
      hash(account) !== binding.fingerprint
    )
      return integrity(message);
    const expected = includeFor(account);
    const expectedRecord = JSON.stringify({
      repo,
      fingerprint: binding.fingerprint,
      includeHash: s.crypto.sha256(expected.content),
      appliedFrom: binding.appliedFrom,
    });
    if (
      content !== expected.content ||
      (record !== undefined && record !== expectedRecord) ||
      (marked &&
        (record === undefined ||
          !current.includes(expected.include) ||
          current.replace(expected.include, "").includes(MARK)))
    )
      return integrity(message);
    const rows = (s.device.read("audit.jsonl") ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) =>
        parseObject<ApprovalRecord & { appliedFrom?: string }>(line, {}),
      );
    const approval = rows.find((row) => row.id === binding.appliedFrom);
    if (
      approval?.kind !== "use" ||
      approval.repo !== repo ||
      approval.fingerprint !== binding.fingerprint ||
      !approval.approval?.quote?.trim() ||
      !approval.approval.source?.trim()
    )
      integrity("The binding has no matching chat approval audit entry");
    ghPin(account.gh);
    const audited = rows.some(
      (row) =>
        row.kind === "apply" &&
        row.repo === repo &&
        row.appliedFrom === binding.appliedFrom,
    );
    if (action === "check") {
      if (record === undefined || !marked || !audited)
        return fail("ACCOUNT_INTEGRITY", message, {
          repair: "Run forge accounts plan to finish the interrupted apply",
        });
      return;
    }
    if (record === undefined)
      s.files.write(paths[1]!, expectedRecord, {
        area: "common",
        expected: null,
      });
    if (!marked)
      s.files.write("config", current + "\n" + expected.include, {
        area: "common",
        expected: configText ?? null,
      });
    if (!audited) audit({ kind: "apply", appliedFrom: binding.appliedFrom });
  }
  recover();
  if (binding?.declined && action !== "use" && action !== "decline")
    return action === "check"
      ? {
          repo,
          declined: true,
          note: "The owner declined account management for this repo; no commit identity check ran",
        }
      : { repo, declined: true };
  const applied = parse<Applied | null>(
    s.files.read("forge/accounts.applied.json", LIMIT, "common"),
    null,
  );
  const owned = s.files.read(OWNED, LIMIT, "common");
  let config = s.files.read("config", LIMIT, "common") ?? "";
  if (
    (owned !== undefined || applied || config.includes(MARK)) &&
    (!applied || !binding?.login || !owned || !config.includes(MARK))
  )
    integrity("Owned include has no matching device binding or clone record");
  if (action === "decline") {
    const lock = s.device.lock();
    try {
      if (
        s.device.read("bindings.json") !== bindingText ||
        s.device.read("accounts.json") !== accountText
      )
        refuse(
          "INPUT_CONFLICT",
          "Accounts changed before declining; plan again",
        );
      if (applied || binding?.login)
        refuse(
          "ACCOUNT_BOUND",
          "An applied binding must be explicitly revoked before declining",
        );
      bindings[repo] = {
        declined: true,
        appliedFrom: audit({ kind: "decline", approval: input.approval }),
      };
      s.device.write("bindings.json", JSON.stringify(bindings));
      return { repo, declined: true };
    } finally {
      lock.release();
    }
  }
  function ghPin(pin?: ExecutablePin) {
    if (!pin) {
      const found = trusted("gh");
      if (!found)
        refuse("UNAVAILABLE", "Install GitHub CLI to detect accounts");
      return found;
    }
    const current = s.device.pin(pin.path, excluded);
    if (JSON.stringify(pin) !== JSON.stringify(current))
      integrity("Pinned gh changed; ask the owner to approve re-pinning");
    return current;
  }
  let selected: Account | undefined;
  if (binding?.login) {
    selected = Object.hasOwn(accounts, binding.login)
      ? accounts[binding.login]
      : undefined;
    if (!selected || hash(selected) !== binding.fingerprint)
      integrity("Approved account definition is missing or changed");
    const approval = (s.device.read("audit.jsonl") ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => parseObject<ApprovalRecord>(line, {}))
      .find((row) => row.id === binding.appliedFrom);
    if (
      approval?.kind !== "use" ||
      approval.repo !== repo ||
      approval.fingerprint !== binding.fingerprint ||
      !approval.approval?.quote?.trim() ||
      !approval.approval.source?.trim()
    )
      integrity("The binding has no matching chat approval audit entry");
    ghPin(selected!.gh);
    if (
      applied &&
      (applied.repo !== repo ||
        applied.fingerprint !== binding.fingerprint ||
        applied.appliedFrom !== binding.appliedFrom ||
        applied.includeHash !== s.crypto.sha256(owned!))
    )
      integrity("Owned Git include or its fingerprint changed");
  }
  const validateInclude = (account: Account) => {
    const expected = includeFor(account);
    if (
      !applied ||
      owned !== expected.content ||
      !config.includes(expected.include) ||
      applied.includeHash !== s.crypto.sha256(expected.content)
    )
      integrity("Owned Git include was changed or is missing");
  };
  if (action === "check") {
    if (!selected || !binding)
      return refuse(
        "ACCOUNT_UNBOUND",
        "No approved GitHub account for this repo; run forge accounts plan --json and relay result.ask",
      );
    validateInclude(selected);
    const limit = settings?.maxCommits ?? MAX_COMMITS;
    if (!Number.isSafeInteger(limit) || limit < 1)
      refuse("INPUT_INVALID", "maxCommits must be a positive integer");
    if (s.files.read("info/grafts", LIMIT, "common"))
      refuse(
        "ACCOUNT_GRAFTED_HISTORY",
        "Git grafts can hide commits from the check; remove the info/grafts file in the common git directory and retry",
      );
    const resolve = async (name: string) => {
      if (!REF.test(name)) refuse("INPUT_INVALID", `Invalid revision ${name}`);
      const out = await g(
        ["rev-parse", "--verify", "--quiet", `${name}^{commit}`],
        true,
      );
      if (!out.ok || !out.text)
        refuse("INPUT_INVALID", `Unknown revision ${name}`);
      return out.text;
    };
    // One git process answers both the shallow test and the tip: the shallow line prints first.
    const tipName = input.tip ?? "HEAD";
    if (!REF.test(tipName))
      refuse("INPUT_INVALID", `Invalid revision ${tipName}`);
    const head = await g(
      [
        "rev-parse",
        "--is-shallow-repository",
        "--verify",
        "--quiet",
        `${tipName}^{commit}`,
      ],
      true,
    );
    const [shallow, tipSha] = head.text.split(/\r?\n/);
    if (!shallow)
      refuse(
        "ACCOUNT_UNAVAILABLE",
        "Account operation failed; verify the binding before continuing",
      );
    if (shallow !== "false")
      refuse(
        "ACCOUNT_SHALLOW_HISTORY",
        "Shallow history hides commits from the check; run git fetch --unshallow and retry",
      );
    if (!head.ok || !tipSha)
      refuse("INPUT_INVALID", `Unknown revision ${tipName}`);
    const tip = tipSha;
    // An explicit all-zero base is a new-branch push: check the tip's full history.
    const newBranch = Boolean(input.base && /^0+$/.test(input.base));
    const base = input.base && !newBranch ? await resolve(input.base) : "";
    const rows = (
      await g([
        "--no-replace-objects",
        "log",
        "--no-show-signature",
        `--max-count=${limit + 1}`,
        "--format=%H%x00%ae%x00%ce",
        tip,
        ...(newBranch ? [] : ["--not", ...(base ? [base] : ["--remotes"])]),
      ])
    ).text
      .split(/\r?\n/)
      .filter(Boolean);
    if (rows.length > limit)
      refuse(
        "ACCOUNT_RANGE_TOO_LARGE",
        `More than ${limit} commits to check; push a smaller range or raise maxCommits`,
      );
    const allowed = selected.commitEmails.map((e) => e.toLowerCase());
    const wrong = rows.flatMap((line) => {
      const [commit, author, committer] = line.split("\0");
      return (
        [
          ["author", author],
          ["committer", committer],
        ] as const
      )
        .filter(([, e]) => !allowed.includes((e ?? "").toLowerCase()))
        .map(([field, e]) => `${commit} ${field}=${e}`);
    });
    if (wrong.length)
      refuse(
        "ACCOUNT_COMMIT_IDENTITY",
        `Push refused: ${wrong.length} commit field(s) do not use GitHub ${selected.login}'s email (${selected.commitEmails.join(", ")}): ${wrong.slice(0, 20).join("; ")}. Rewrite those commits with the bound identity, then check again.`,
      );
    return { repo, login: selected.login, checked: rows.length };
  }
  const pin = ghPin(selected?.gh);
  const gh: ResolvedExecutable = { kind: "resolved", path: pin.path };
  const ghEnv = {
    ...env,
    ...s.environment.select(["APPDATA", "GH_CONFIG_DIR", "XDG_CONFIG_HOME"]),
  };
  // Token-bearing calls only: the bound login's token, in the child env, never argv.
  const secrets: string[] = [];
  const redact = (text: string) =>
    secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), text);
  // One token lookup per login per invocation: each lookup is a gh process.
  const tokens = new Map<string, string>();
  async function api(login: string, args: string[], optional = false) {
    let token = tokens.get(login);
    if (token === undefined) {
      const out = await run(
        gh,
        ["auth", "token", "--hostname", "github.com", "--user", login],
        true,
        ghEnv,
        { sensitive: true },
      );
      // Exactly one token line: only the terminal newline is removed.
      token = out.raw.replace(/\r?\n$/, "");
      if (!out.ok || !/^\S{8,512}$/.test(token))
        return optional
          ? { ok: false, text: "" }
          : refuse("ACCOUNT_VERIFY_FAILED", `gh has no token for ${login}`);
      secrets.push(token);
      tokens.set(login, token);
    }
    // A fresh empty config directory in the private device root, never one the clone can write.
    const scratch = s.device.scratch();
    try {
      const result = await run(
        gh,
        ["api", ...args],
        optional,
        {
          ...env,
          GH_TOKEN: token,
          GH_HOST: "github.com",
          GH_CONFIG_DIR: scratch.path,
          GH_PROMPT_DISABLED: "1",
        },
        { redact: [token] },
      );
      return { ok: result.ok, text: redact(result.text) };
    } finally {
      scratch.remove();
    }
  }
  const json = <T,>(text: string, fallback: T): T => {
    try {
      return JSON.parse(text) as T;
    } catch {
      return fallback;
    }
  };
  type Candidate = { login: string; active: boolean };
  type Unpushed = { commit: string; author: string; committer: string };
  // A bound `use` only needs the token proof below, so it skips the account listing and the git
  // reads that feed a question it never asks: each one is a process start. A signed-out login
  // still refuses, because its token lookup fails with the same ACCOUNT_VERIFY_FAILED.
  const bound = action === "use" && selected !== undefined && binding;
  const discover = !bound;
  // An unbound `use` that names its login skips only gh's account listing: the token proof below
  // is what shows the login is signed in, and the git reads still feed the commit and email hazards.
  const named =
    action === "use" && !bound && input.login ? input.login : undefined;
  if (named !== undefined && !/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(named))
    refuse("ACCOUNT_UNKNOWN", "Name a signed-in GitHub account");
  const detect = async (): Promise<Candidate[]> => {
    const status = await run(
      gh,
      ["auth", "status", "--hostname", "github.com", "--json", "hosts"],
      true,
      ghEnv,
    );
    if (status.ok) {
      const data = parse<{
        hosts?: Record<
          string,
          { login: string; active: boolean; state: string; host: string }[]
        >;
      }>(status.text, {});
      return (data.hosts?.["github.com"] ?? [])
        .filter(
          (row) =>
            row.state === "success" &&
            row.host === "github.com" &&
            /^[a-z\d](?:[a-z\d-]{0,38})$/i.test(row.login),
        )
        .map(({ login, active }) => ({ login, active }));
    }
    if (/unknown flag.*json/i.test(status.error)) {
      const text = await run(
        gh,
        ["auth", "status", "--hostname", "github.com"],
        false,
        ghEnv,
      );
      return [
        ...(text.text + "\n" + text.error).matchAll(
          /Logged in to github\.com account ([a-z\d-]+)[^\r\n]*\r?\n\s*- Active account: (true|false)/gi,
        ),
      ].map((row) => ({ login: row[1]!, active: row[2] === "true" }));
    }
    return refuse("ACCOUNT_UNAVAILABLE", "GitHub account detection failed");
  };
  const history = async (): Promise<Unpushed[]> => {
    const log = await g(
      ["log", "--format=%H%x00%ae%x00%ce", "HEAD", "--not", "--remotes=origin"],
      true,
    );
    // An unborn HEAD has no commits to list; any other failure still refuses.
    if (!log.ok && (await g(["rev-parse", "--verify", "HEAD"], true)).ok)
      refuse(
        "ACCOUNT_UNAVAILABLE",
        "Account operation failed; verify the binding before continuing",
      );
    return log.ok
      ? log.text
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => {
            const [commit, author, committer] = line.split("\0");
            return { commit: commit!, author: author!, committer: committer! };
          })
      : [];
  };
  const idle = { ok: true, text: "", raw: "", error: "" };
  // The process supervisor caps concurrent children, so these run one after another.
  const candidates: Candidate[] = named
    ? [{ login: named, active: false }]
    : discover
      ? await detect()
      : [];
  const unpushed = discover ? await history() : [];
  const identityRows = discover
    ? await g(
        [
          "config",
          "-z",
          "--show-origin",
          "--get-regexp",
          "^(user\\.email|includeif\\.)",
        ],
        true,
      )
    : idle;
  const recentRows = discover
    ? await g(["log", "-20", "--format=%ae%x00%ce"], true)
    : idle;
  if (
    discover &&
    selected &&
    !candidates.some(
      (c) => c.login.toLowerCase() === selected.login.toLowerCase(),
    )
  )
    refuse(
      "ACCOUNT_VERIFY_FAILED",
      `Approved GitHub account ${selected.login} is absent from gh's signed-in accounts`,
    );
  const recent = recentRows.text;
  // With -z each entry is `origin NUL key NL value NUL` (a valueless key has no NL), so a value
  // holding newlines or tabs cannot pass for another entry.
  const listed = identityRows.raw.split("\0");
  const entries: { origin: string; key: string; value: string | null }[] = [];
  for (let at = 0; at + 1 < listed.length; at += 2) {
    const record = listed[at + 1]!;
    const split = record.indexOf("\n");
    entries.push({
      origin: listed[at]!,
      key: split < 0 ? record : record.slice(0, split),
      value: split < 0 ? null : record.slice(split + 1),
    });
  }
  const identities = entries
    .map(
      (row) =>
        `${row.origin}\t${row.key}${row.value === null ? "" : ` ${row.value}`}`,
    )
    .join("\n");
  // The effective user.email is the last one the listing shows; no separate git config call.
  const email = entries.reduce(
    (last, row) => (row.key === "user.email" ? (row.value ?? "") : last),
    "",
  );
  const belongs = (address: string, login: string) =>
    new RegExp(
      `^(?:[0-9]+\\+)?${login}@users\\.noreply\\.github\\.com$`,
      "i",
    ).test(address);
  const owner = candidates.find(
    (c) => c.login.toLowerCase() === match?.[1]?.toLowerCase(),
  );
  const emailMatches = candidates.filter((c) =>
    [email, ...recent.split(/[\0\r\n]/)].some((e) => belongs(e, c.login)),
  );
  const pushers: string[] = [];
  let denied = 0;
  // The remote's owner is always the pick, so the owner's own permission never changes the answer,
  // and no other account's push permission can either. A named login needs none of them.
  // Each skipped lookup saves two gh processes per signed-in account.
  const permissionsChecked = !named && !owner;
  if (match && !selected && permissionsChecked)
    for (const c of candidates) {
      const row = await api(c.login, [`repos/${match[1]}/${match[2]}`], true);
      const push = row.ok
        ? json<{ permissions?: { push?: boolean } }>(row.text, {}).permissions
            ?.push
        : undefined;
      if (push === true) pushers.push(c.login);
      else if (push === false) denied++;
    }
  const byEmail = emailMatches.filter(
    (c) => !pushers.length || pushers.includes(c.login),
  );
  const onlyPusher =
    pushers.length === 1
      ? candidates.find((c) => c.login === pushers[0])
      : undefined;
  const pick = selected
    ? candidates.find((c) => c.login === selected.login)
    : named
      ? candidates[0]
      : (owner ??
        onlyPusher ??
        (byEmail.length === 1 ? byEmail[0] : undefined));
  const reason = selected
    ? "previously approved for this repo"
    : owner
      ? "owns the remote"
      : named
        ? "named in the owner's reply"
        : pick && pick === onlyPusher
          ? "is the only signed-in account with push access to the remote"
          : pick
            ? "matches the commit email"
            : "no signal chooses one account";
  const hazards: string[] = [];
  const active = candidates.find((c) => c.active);
  if (pick && active && active.login !== pick.login)
    hazards.push(`gh is signed in as ${active.login} right now`);
  if (pick && email && !belongs(email, pick.login))
    hazards.push(
      `effective user.email is ${email}, outside ${pick.login}'s noreply identity`,
    );
  if (!pushers.length && candidates.length && denied === candidates.length)
    hazards.push("no signed-in account can push to this remote");
  if (pick && pushers.length && !pushers.includes(pick.login))
    hazards.push(
      `${pick.login} cannot push to this remote; ${pushers.join(", ")} can`,
    );
  const wrong = pick
    ? unpushed.filter(
        (c) =>
          !belongs(c.author, pick.login) || !belongs(c.committer, pick.login),
      )
    : [];
  if (wrong.length)
    hazards.push(
      `${wrong.length} unpushed commit(s) use another account's email: ${wrong.map((c) => `${c.commit} (${c.author}, ${c.committer})`).join(", ")}`,
    );
  const ask = `This repo is ${match ? `${match[1]}/${match[2]}` : "local"}. ${pick ? `I will use GitHub ${pick.login} for it (${reason}; commits will use ${pick.login}'s noreply address).` : `Choose GitHub: ${candidates.map((c, i) => `${i + 1}. ${c.login}`).join(", ") || "no signed-in accounts found"}.`} ${hazards.length ? `Caught: ${hazards.join("; ")}. Without this binding the next push could carry another identity. ` : ""}Reply yes, or name a different account.`;
  function audit(value: object) {
    const id = s.crypto.randomUUID();
    const previous = s.device.read("audit.jsonl") ?? "";
    s.device.write(
      "audit.jsonl",
      previous + JSON.stringify({ id, repo, ...value }) + "\n",
    );
    return id;
  }
  function apply(account: Account, approved: Binding) {
    const fingerprint = hash(account);
    const { content, include } = includeFor(account);
    if (applied) validateInclude(account);
    else {
      const lease = s.files.lock(["forge/accounts.apply.lock"]);
      try {
        s.files.write(OWNED, content, { area: "common", expected: null });
        s.files.write(
          "forge/accounts.applied.json",
          JSON.stringify({
            repo,
            fingerprint,
            includeHash: s.crypto.sha256(content),
            appliedFrom: approved.appliedFrom,
          }),
          { area: "common", expected: null },
        );
        s.files.write("config", config + "\n" + include, {
          area: "common",
          expected: config,
        });
        config += "\n" + include;
        audit({ kind: "apply", appliedFrom: approved.appliedFrom });
      } finally {
        lease.release();
      }
    }
  }
  // One call answers who the token belongs to: its own login, numeric id and display name.
  const identify = async (login: string) => {
    const me = json<{ login?: string; id?: number; name?: string | null }>(
      (await api(login, ["user"])).text,
      {},
    );
    if (me.login?.toLowerCase() !== login.toLowerCase())
      refuse(
        "ACCOUNT_VERIFY_FAILED",
        `The gh token for ${login} belongs to another GitHub account`,
      );
    const id = me.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)
      refuse(
        "ACCOUNT_VERIFY_FAILED",
        "GitHub did not return a public account id",
      );
    return { id, name: typeof me.name === "string" ? me.name : null };
  };
  const confirmToken = async (account: Account) => {
    if ((await identify(account.login)).id !== account.userId)
      refuse(
        "ACCOUNT_VERIFY_FAILED",
        `The gh token for ${account.login} belongs to another GitHub account`,
      );
  };
  const verifyIdentity = async (account: Account) => {
    const callerEnv = s.environment.inherit();
    for (const role of ["AUTHOR", "COMMITTER"] as const) {
      const prefix = `GIT_${role}`;
      const ident = await run(git, ["var", `${prefix}_IDENT`], true, callerEnv);
      const roleKey = `${role.toLowerCase()}.email`;
      if (!ident.ok)
        integrity(
          `Cannot verify ${prefix}_IDENT in the caller environment; inspect ${roleKey} and inherited Git overrides`,
        );
      const effectiveEmail = / <([^<>\r\n]*)> -?\d+ [+-]\d{4}$/.exec(
        ident.text,
      )?.[1];
      if (!effectiveEmail || !account.commitEmails.includes(effectiveEmail)) {
        const overridingKey = Object.keys(callerEnv).some(
          (key) =>
            (s.environment.platform === "win32" ? key.toUpperCase() : key) ===
            `${prefix}_EMAIL`,
        )
          ? `${prefix}_EMAIL`
          : (await run(git, ["config", roleKey], true, callerEnv)).ok
            ? roleKey
            : "user.email";
        integrity(
          `${overridingKey} overrides the effective ${role.toLowerCase()} email for GitHub ${account.login}`,
        );
      }
    }
    // One git process lists the three keys; the last value of each is the effective one.
    // -z records are `key NL value NUL`, so a value cannot pass for another key, and an empty
    // value stays distinct from a key with no value.
    const records = (
      await g(
        ["config", "-z", "--get-regexp", "^user\\.(email|useconfigonly|name)$"],
        true,
      )
    ).raw
      .split("\0")
      .filter(Boolean);
    const effective = (key: string) =>
      records.reduce<string | null | undefined>((last, record) => {
        const split = record.indexOf("\n");
        if ((split < 0 ? record : record.slice(0, split)) !== key) return last;
        return split < 0 ? null : record.slice(split + 1);
      }, undefined);
    // As `git config --bool` reads it: a key with no value is true, an empty value is false, and a
    // decimal integer is true unless it is 0. Forms git reads differently (0x10, 010) are refused.
    const configOnly = effective("user.useconfigonly");
    const configOnlyTrue =
      configOnly === null ||
      (configOnly !== undefined &&
        (/^(?:true|yes|on)$/i.test(configOnly) ||
          (/^[+-]?(?:0|[1-9]\d*)$/.test(configOnly) &&
            Number(configOnly) !== 0 &&
            Math.abs(Number(configOnly)) <= 2147483647)));
    if (
      effective("user.email") !== account.commitEmails[0] ||
      !configOnlyTrue ||
      effective("user.name") !== account.commitName
    )
      integrity("Effective Git identity overrides the approved include");
  };
  const lock = s.device.lock();
  try {
    if (
      s.device.read("bindings.json") !== bindingText ||
      s.device.read("accounts.json") !== accountText
    )
      refuse("INPUT_CONFLICT", "Accounts changed during discovery; plan again");
    if (action === "use") {
      if (selected && binding) {
        if (input.login && input.login !== selected.login)
          refuse(
            "ACCOUNT_BOUND",
            "Rebinding requires explicit revocation first",
          );
        await confirmToken(selected);
        apply(selected, binding);
        await verifyIdentity(selected);
        return {
          repo,
          login: selected.login,
          appliedFrom: binding.appliedFrom,
        };
      }
      const login = input.login ?? pick?.login;
      if (!login || !candidates.some((c) => c.login === login))
        refuse("ACCOUNT_UNKNOWN", "Name a signed-in GitHub account");
      const info = await identify(login);
      const existing = Object.hasOwn(accounts, login)
        ? accounts[login]
        : undefined;
      if (
        existing &&
        (existing.userId !== info.id ||
          JSON.stringify(existing.gh) !== JSON.stringify(pin) ||
          Object.values(bindings).some(
            (b) => b.login === login && b.fingerprint !== hash(existing),
          ))
      )
        integrity(
          "Existing account identity or pin changed; preserve its approved definitions",
        );
      const account: Account = existing ?? {
        login,
        userId: info.id,
        commitName: info.name?.trim() || login,
        commitEmails: [`${info.id}+${login}@users.noreply.github.com`],
        gh: pin,
      };
      if (/[\r\n\0]/.test(account.commitName))
        refuse("INPUT_INVALID", "Invalid GitHub commit name");
      // The one api user call above already proved the token's login and id, so an existing
      // account needs no second proof. The generated noreply address is built from that
      // verified id; only a custom commit email needs GitHub's email list.
      const generated = `${account.userId}+${login}@users.noreply.github.com`;
      const custom = account.commitEmails.filter(
        (e) => e.toLowerCase() !== generated.toLowerCase(),
      );
      let listed: Set<string> | undefined;
      if (custom.length) {
        const page = await api(login, ["user/emails", "--paginate"], true);
        // Every page must succeed; a partial list is never accepted.
        if (!page.ok && page.text.startsWith("["))
          refuse(
            "ACCOUNT_VERIFY_FAILED",
            `GitHub's email list for ${login} was incomplete (a page failed); try again`,
          );
        listed = page.ok
          ? new Set(
              json<{ email?: string }[]>(
                page.text.replace(/\]\s*\[/g, ","),
                [],
              ).map((row) => (row.email ?? "").toLowerCase()),
            )
          : undefined;
        const unlisted = custom.filter((e) => !listed?.has(e.toLowerCase()));
        if (unlisted.length)
          refuse(
            "ACCOUNT_VERIFY_FAILED",
            listed
              ? `GitHub ${login} does not list these commit emails: ${unlisted.join(", ")}`
              : `Cannot confirm the custom commit emails ${unlisted.join(", ")}: the gh token for ${login} needs the user:email permission to read GitHub's email list`,
          );
      }
      const approved: Binding = {
        login,
        fingerprint: hash(account),
        appliedFrom: audit({
          kind: "use",
          ask,
          proposal: pick?.login ?? null,
          permissionsChecked,
          input: { login },
          fingerprint: hash(account),
          approval: input.approval,
        }),
      };
      accounts[login] = account;
      bindings[repo] = approved;
      s.device.write("accounts.json", JSON.stringify(accounts));
      s.device.write("bindings.json", JSON.stringify(bindings));
      apply(account, approved);
      await verifyIdentity(account);
      return {
        repo,
        login,
        appliedFrom: approved.appliedFrom,
        emails: listed ? "listed" : "noreply-only",
      };
    }
    if (binding?.declined) return { repo, declined: true };
    if (selected && binding) {
      apply(selected, binding);
      await verifyIdentity(selected);
    }
    if (!selected) audit({ kind: "ask", ask });
    return {
      repo,
      candidates,
      proposal: pick ? { login: pick.login } : null,
      reason,
      hazards,
      ask: selected
        ? `Using GitHub ${selected.login} for this clone, from approval ${binding!.appliedFrom}.`
        : ask,
      identities,
      recent,
      appliedFrom: binding?.appliedFrom ?? null,
    };
  } finally {
    lock.release();
  }
}
module.exports = {
  "accounts.plan": (call: Call) => contact(call, "plan"),
  "accounts.use": (call: Call) => contact(call, "use"),
  "accounts.decline": (call: Call) => contact(call, "decline"),
  "accounts.check": (call: Call) => contact(call, "check"),
};
