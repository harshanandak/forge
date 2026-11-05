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
}
interface Call {
  input: Input;
  services: Services;
}
interface ApprovalRecord {
  id?: string;
  repo?: string;
  kind?: string;
  fingerprint?: string;
  approval?: { quote?: string; source?: string };
}
const LIMIT = 1048576,
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
async function contact(
  { input, services: s }: Call,
  action: "plan" | "use" | "decline",
) {
  if (
    (action === "use" || action === "decline") &&
    (!input.approval?.quote?.trim() || !input.approval.source?.trim())
  )
    refuse(
      "APPROVAL_REQUIRED",
      "Relay the owner's chat reply with approval: {quote, source}",
    );
  if (
    action === "use" &&
    /^(?:(?:please|thanks)[,\s]+)?(?:no\b|nope\b|not\b|never\b|decline\b|refuse\b|do\s+not\b|don['’]t\b)/i.test(
      input.approval!.quote.trim(),
    )
  )
    refuse(
      "APPROVAL_REQUIRED",
      "A refusal is not approval; relay it through accounts decline",
    );
  const env: Record<string, string> = {
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
  const git = s.process.resolve("git", env);
  if (git.kind !== "resolved") refuse("UNAVAILABLE", "Accounts requires Git");
  async function run(
    exe: ResolvedExecutable,
    args: string[],
    optional = false,
    childEnv = env,
  ) {
    const out = await s.process.run(exe, args, {
      cwd: s.files.root,
      env: childEnv,
      timeoutMs: 10000,
      maxOutputBytes: LIMIT,
    });
    if (out.timedOut || out.truncated || (out.exitCode !== 0 && !optional))
      refuse(
        "ACCOUNT_UNAVAILABLE",
        "Account operation failed; verify the binding before continuing",
      );
    return {
      ok: out.exitCode === 0,
      text: out.stdout.trim(),
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
  const bindings = parse<Record<string, Binding>>(bindingText, {});
  const accounts = parse<Record<string, Account>>(accountText, {});
  const binding = Object.hasOwn(bindings, repo) ? bindings[repo] : undefined;
  if (binding?.declined && action !== "use" && action !== "decline")
    return { repo, declined: true };
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
  function ghPin(pin?: ExecutablePin) {
    const excluded = [
      s.files.root,
      env.TEMP ?? "",
      env.TMP ?? "",
      env.TMPDIR ?? "/tmp",
    ];
    const pathKey =
      Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    const separator = s.environment.platform === "win32" ? ";" : ":";
    if (!pin)
      for (const directory of (env[pathKey] ?? "").split(separator)) {
        const candidate = s.process.resolve("gh", {
          ...env,
          [pathKey]: directory,
        });
        if (candidate.kind !== "resolved") continue;
        try {
          return s.device.pin(candidate.path, excluded);
        } catch {
          /* Skip untrusted search entries before spawning. */
        }
      }
    const resolved = pin
      ? { kind: "resolved" as const, path: pin.path }
      : s.process.resolve("gh", { ...env, [pathKey]: "" });
    if (resolved.kind !== "resolved")
      refuse("UNAVAILABLE", "Install GitHub CLI to detect accounts");
    const current = s.device.pin(resolved.path, excluded);
    if (pin && JSON.stringify(pin) !== JSON.stringify(current))
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
      .map((line) => parse<ApprovalRecord>(line, {}))
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
  const pin = ghPin(selected?.gh);
  const gh: ResolvedExecutable = { kind: "resolved", path: pin.path };
  const ghEnv = {
    ...env,
    ...s.environment.select(["APPDATA", "GH_CONFIG_DIR", "XDG_CONFIG_HOME"]),
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
  const pick = selected
    ? candidates.find((c) => c.login === selected.login)
    : (owner ?? (emailMatches.length === 1 ? emailMatches[0] : undefined));
  const reason = selected
    ? "previously approved for this repo"
    : owner
      ? "owns the remote"
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
    const content = `# forge accounts ${fingerprint}\n[user]\n\tname = ${JSON.stringify(account.commitName)}\n\temail = ${JSON.stringify(account.commitEmails[0])}\n\tuseConfigOnly = true\n`;
    const include = `${MARK}\n[include]\n\tpath = "forge/accounts.gitconfig"\n# end forge accounts owned include\n`;
    if (applied) {
      if (!config.includes(include) || owned !== content)
        integrity("Owned Git include was changed");
    } else {
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
  async function verifyIdentity(account: Account) {
    if (
      (await g(["config", "user.email"])).text !== account.commitEmails[0] ||
      (await g(["config", "--bool", "user.useConfigOnly"])).text !== "true" ||
      (await g(["config", "user.name"])).text !== account.commitName
    )
      integrity("Effective Git identity overrides the approved include");
  }
  const lock = s.device.lock();
  try {
    if (
      s.device.read("bindings.json") !== bindingText ||
      s.device.read("accounts.json") !== accountText
    )
      refuse("INPUT_CONFLICT", "Accounts changed during discovery; plan again");
    if (action === "decline") {
      if (applied || binding?.login)
        refuse(
          "ACCOUNT_BOUND",
          "An applied binding must be explicitly revoked before declining",
        );
      bindings[repo] = {
        declined: true,
        appliedFrom: audit({ kind: "decline", approval: input.approval, ask }),
      };
      s.device.write("bindings.json", JSON.stringify(bindings));
      return { repo, declined: true };
    }
    if (action === "use") {
      if (selected && binding) {
        if (input.login && input.login !== selected.login)
          refuse(
            "ACCOUNT_BOUND",
            "Rebinding requires explicit revocation first",
          );
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
      if (
        login !== pick?.login &&
        !input.approval!.quote.toLowerCase().includes(login.toLowerCase())
      )
        refuse(
          "APPROVAL_REQUIRED",
          "The reply must name the revised account choice",
        );
      const info = parse<{ id?: number; name?: string | null }>(
        (await run(gh, ["api", `users/${login}`], false, ghEnv)).text,
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
      return { repo, login, appliedFrom: approved.appliedFrom };
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
};
