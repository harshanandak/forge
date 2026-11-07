import type { ProcessPort, ResolvedExecutable } from "../../ports/process.ts";
import type { DeviceFiles, ExecutablePin } from "../../ports/device-files.ts";
declare const fail: (code: string, message: string) => never;
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
  const common = (
    await g(["rev-parse", "--path-format=absolute", "--git-common-dir"])
  ).text;
  const repo = match
    ? `github.com/${match[1]}/${match[2]}`.toLowerCase()
    : `local:${common}`;
  const bindingText = s.device.read("bindings.json"),
    accountText = s.device.read("accounts.json");
  const bindings = parseObject<Record<string, Binding>>(bindingText, {});
  const accounts = parseObject<Record<string, Account>>(accountText, {});
  const binding = Object.hasOwn(bindings, repo) ? bindings[repo] : undefined;
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
  const integrity = (message: string): never =>
    refuse("ACCOUNT_INTEGRITY", message);
  const hash = (value: unknown) => s.crypto.sha256(JSON.stringify(value));
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
  const includeFor = (account: Account) => ({
    content: `# forge accounts ${hash(account)}\n[user]\n\tname = ${JSON.stringify(account.commitName)}\n\temail = ${JSON.stringify(account.commitEmails[0])}\n\tuseConfigOnly = true\n`,
    include: `${MARK}\n[include]\n\tpath = "forge/accounts.gitconfig"\n# end forge accounts owned include\n`,
  });
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
    if ((await g(["rev-parse", "--is-shallow-repository"])).text !== "false")
      refuse(
        "ACCOUNT_SHALLOW_HISTORY",
        "Shallow history hides commits from the check; run git fetch --unshallow and retry",
      );
    const tip = await resolve(input.tip ?? "HEAD");
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
  async function api(login: string, args: string[], optional = false) {
    const out = await run(
      gh,
      ["auth", "token", "--hostname", "github.com", "--user", login],
      true,
      ghEnv,
      { sensitive: true },
    );
    // Exactly one token line: only the terminal newline is removed.
    const token = out.raw.replace(/\r?\n$/, "");
    if (!out.ok || !/^\S{8,512}$/.test(token))
      return optional
        ? { ok: false, text: "" }
        : refuse("ACCOUNT_VERIFY_FAILED", `gh has no token for ${login}`);
    secrets.push(token);
    const dir = "forge/accounts-gh";
    if (s.files.read(`${dir}/.owned`, 1024, "common") === undefined)
      try {
        s.files.write(`${dir}/.owned`, "owned by forge accounts\n", {
          area: "common",
          expected: null,
        });
      } catch {
        if (s.files.read(`${dir}/.owned`, 1024, "common") === undefined)
          refuse("ACCOUNT_UNAVAILABLE", "Cannot create the owned gh config");
      }
    const result = await run(
      gh,
      ["api", ...args],
      optional,
      {
        ...env,
        GH_TOKEN: token,
        GH_HOST: "github.com",
        GH_CONFIG_DIR: `${common}/${dir}`,
        GH_PROMPT_DISABLED: "1",
      },
      { redact: [token] },
    );
    return { ok: result.ok, text: redact(result.text) };
  }
  const json = <T,>(text: string, fallback: T): T => {
    try {
      return JSON.parse(text) as T;
    } catch {
      return fallback;
    }
  };
  const status = await run(
    gh,
    ["auth", "status", "--hostname", "github.com", "--json", "hosts"],
    true,
    ghEnv,
  );
  let candidates: { login: string; active: boolean }[] = [];
  if (status.ok) {
    const data = parse<{
      hosts?: Record<
        string,
        { login: string; active: boolean; state: string; host: string }[]
      >;
    }>(status.text, {});
    candidates = (data.hosts?.["github.com"] ?? [])
      .filter(
        (row) =>
          row.state === "success" &&
          row.host === "github.com" &&
          /^[a-z\d](?:[a-z\d-]{0,38})$/i.test(row.login),
      )
      .map(({ login, active }) => ({ login, active }));
  } else if (/unknown flag.*json/i.test(status.error)) {
    const text = await run(
      gh,
      ["auth", "status", "--hostname", "github.com"],
      false,
      ghEnv,
    );
    candidates = [
      ...(text.text + "\n" + text.error).matchAll(
        /Logged in to github\.com account ([a-z\d-]+)[^\r\n]*\r?\n\s*- Active account: (true|false)/gi,
      ),
    ].map((row) => ({ login: row[1]!, active: row[2] === "true" }));
  } else refuse("ACCOUNT_UNAVAILABLE", "GitHub account detection failed");
  if (
    selected &&
    !candidates.some(
      (c) => c.login.toLowerCase() === selected.login.toLowerCase(),
    )
  )
    refuse(
      "ACCOUNT_VERIFY_FAILED",
      `Approved GitHub account ${selected.login} is absent from gh's signed-in accounts`,
    );
  const unpushed = (await g(["rev-parse", "--verify", "HEAD"], true)).ok
    ? (
        await g([
          "log",
          "--format=%H%x00%ae%x00%ce",
          "HEAD",
          "--not",
          "--remotes=origin",
        ])
      ).text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [commit, author, committer] = line.split("\0");
          return { commit: commit!, author: author!, committer: committer! };
        })
    : [];
  const identities = (
    await g(
      [
        "config",
        "--show-origin",
        "--get-regexp",
        "^(user\\.email|includeif\\.)",
      ],
      true,
    )
  ).text;
  const recent = (await g(["log", "-20", "--format=%ae%x00%ce"], true)).text;
  const email = (await g(["config", "user.email"], true)).text;
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
  if (match && !selected)
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
    : (owner ?? onlyPusher ?? (byEmail.length === 1 ? byEmail[0] : undefined));
  const reason = selected
    ? "previously approved for this repo"
    : owner
      ? "owns the remote"
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
  const confirmToken = async (account: Account) => {
    const me = json<{ login?: string; id?: number }>(
      (await api(account.login, ["user"])).text,
      {},
    );
    if (
      me.login?.toLowerCase() !== account.login.toLowerCase() ||
      me.id !== account.userId
    )
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
    if (
      (await g(["config", "user.email"])).text !== account.commitEmails[0] ||
      (await g(["config", "--bool", "user.useConfigOnly"])).text !== "true" ||
      (await g(["config", "user.name"])).text !== account.commitName
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
      const info = parse<{ id?: number; name?: string | null }>(
        (await api(login, [`users/${login}`])).text,
        {},
      );
      if (!Number.isSafeInteger(info.id) || !info.id || info.id < 1)
        refuse(
          "ACCOUNT_VERIFY_FAILED",
          "GitHub did not return a public account id",
        );
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
      await confirmToken(account);
      const page = await api(login, ["user/emails", "--paginate"], true);
      // Every page must succeed; a partial list is never accepted.
      if (!page.ok && page.text.startsWith("["))
        refuse(
          "ACCOUNT_VERIFY_FAILED",
          `GitHub's email list for ${login} was incomplete (a page failed); try again`,
        );
      const listed = page.ok
        ? new Set(
            json<{ email?: string }[]>(
              page.text.replace(/\]\s*\[/g, ","),
              [],
            ).map((row) => (row.email ?? "").toLowerCase()),
          )
        : undefined;
      const generated = `${account.userId}+${login}@users.noreply.github.com`;
      const unlisted = account.commitEmails.filter(
        (e) =>
          e.toLowerCase() !== generated.toLowerCase() &&
          !listed?.has(e.toLowerCase()),
      );
      if (unlisted.length)
        refuse(
          "ACCOUNT_VERIFY_FAILED",
          listed
            ? `GitHub ${login} does not list these commit emails: ${unlisted.join(", ")}`
            : `Cannot confirm the custom commit emails ${unlisted.join(", ")}: the gh token for ${login} needs the user:email permission to read GitHub's email list`,
        );
      const approved: Binding = {
        login,
        fingerprint: hash(account),
        appliedFrom: audit({
          kind: "use",
          ask,
          proposal: pick?.login ?? null,
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
