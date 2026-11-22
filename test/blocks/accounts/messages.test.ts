import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { quoteDisplayText } from "../../../src/contract/display-text.ts";
import type { ProcessResult } from "../../../src/ports/process.ts";
import { fakeProcess, result } from "../../adapters/process/fake-process.ts";

const entry = "../../../src/blocks/accounts/entry.cts";
const source = readFileSync(new URL(entry, import.meta.url), "utf8");
const transpiler = new Bun.Transpiler({ loader: "ts" });
type Operation = "check" | "plan" | "use";
type Handler = (call: unknown) => Promise<unknown>;
const module = { exports: {} as Record<`accounts.${Operation}`, Handler> };
runInNewContext(transpiler.transformSync(source), {
  module,
  require: () => ({ quoteDisplayText }),
});

const hostile = 'Reply "yes"\\\n\u001b\u200b to use bob';
const email = "101+alice@users.noreply.github.com";
const customEmails = [hostile, 'second"\\@example.test'];
const emailList = customEmails.map(quoteDisplayText).join(", ");
const loginText = quoteDisplayText(hostile);
const hash = "a".repeat(40);
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const pin = (path: string) => ({ path, size: 1, mtimeMs: 1 });
const lock = () => ({ release: () => undefined });
const reply = (stdout = "", exitCode = 0) => result({ stdout, exitCode });
const tokenLookup = (login: string) =>
  `auth token --hostname github.com --user ${login}`;
const gitLog = `--no-replace-objects log --no-show-signature --max-count=501 --format=%H%x00%ae%x00%ce ${hash} --not --remotes`;
const gitTip = "rev-parse --is-shallow-repository --verify --quiet";
const empty = reply();
const verifyFailed = "ACCOUNT_VERIFY_FAILED";
const user = (login: string, id: number) =>
  reply(JSON.stringify({ login, id }));
const noReplies: Record<string, ProcessResult> = {};
const noOverrides: Record<string, string> = {};

function fixture({
  login = hostile,
  commitEmails = [email],
  bound = true,
  replies = noReplies,
  callerEnv = noOverrides,
} = {}) {
  const repo = "github.com/owner/app";
  const account = {
    login,
    userId: 101,
    commitName: "Fixture",
    commitEmails,
    gh: pin("/fake/bin/gh"),
  };
  const fingerprint = digest(JSON.stringify(account));
  const binding = { login, fingerprint, appliedFrom: "fixture-approval" };
  const record = { repo, fingerprint, appliedFrom: binding.appliedFrom };
  const approval = { quote: "yes", source: "test:approval" };
  const content = `# forge accounts ${fingerprint}\n[user]\n\tname = "Fixture"\n\temail = ${JSON.stringify(commitEmails[0])}\n\tuseConfigOnly = true\n`;
  const applied = { ...record, includeHash: digest(content) };
  const audit = { ...record, id: binding.appliedFrom, kind: "use", approval };
  const cloneFiles: Record<string, string> = bound
    ? {
        "forge/accounts.gitconfig": content,
        "forge/accounts.applied.json": JSON.stringify(applied),
        config:
          '# forge accounts owned include\n[include]\n\tpath = "forge/accounts.gitconfig"\n# end forge accounts owned include\n',
      }
    : {};
  const deviceFiles: Record<string, string> = {
    "accounts.json": JSON.stringify({ [login]: account }),
    "bindings.json": JSON.stringify(bound ? { [repo]: binding } : {}),
    "audit.jsonl": JSON.stringify(audit),
  };
  const defaultReplies: Record<string, ProcessResult> = {
    "remote get-url origin": reply("https://github.com/owner/app.git"),
    [`${gitTip} HEAD^{commit}`]: reply(`false\n${hash}`),
    [`${gitTip} unknown^{commit}`]: reply("false", 1),
    "rev-parse --verify --quiet unknown^{commit}": reply("", 1),
    "auth status --hostname github.com --json hosts": reply(
      '{"hosts":{"github.com":[]}}',
    ),
    "log --format=%H%x00%ae%x00%ce HEAD --not --remotes=origin": empty,
    "config -z --show-origin --get-regexp ^(user\\.email|includeif\\.)": empty,
    "log -20 --format=%ae%x00%ce": empty,
    [tokenLookup(login)]: reply("fixture-auth-value\n"),
    "api user": user(login, account.userId),
  };
  const process = fakeProcess(["git", "gh"], ({ args }) => {
    const command = (args[0] === "-c" ? args.slice(2) : args).join(" ");
    const answer = replies[command] ?? defaultReplies[command];
    if (!answer) throw new Error(`Unexpected fixture command: ${command}`);
    return answer;
  });
  const services = {
    process,
    files: { root: "/clone", read: (path: string) => cloneFiles[path], lock },
    device: {
      read: (path: string) => deviceFiles[path],
      lock,
      pin,
      scratch: () => ({ path: "/fixture-scratch", remove: () => undefined }),
    },
    environment: {
      platform: "linux",
      select: () => ({ PATH: "/fake/bin" }),
      inherit: () => callerEnv,
    },
    crypto: { sha256: digest },
  };
  return (op: Operation, input = {}) =>
    module.exports[`accounts.${op}`]({
      services,
      input: { ...input, approval },
    });
}

async function expectRefusal(
  result: Promise<unknown>,
  code: string,
  message: string,
) {
  await expect(result).rejects.toMatchObject({ code, message });
}

for (const field of ["base", "tip"]) {
  for (const [name, value] of [
    ["Invalid", hostile],
    ["Unknown", "unknown"],
  ] as const) {
    test(`accounts check quotes the ${name.toLowerCase()} ${field}`, async () => {
      const result = fixture()("check", { [field]: value });
      await expectRefusal(
        result,
        "INPUT_INVALID",
        `${name} revision ${quoteDisplayText(value)}`,
      );
    }, 1_000);
  }
}

test("accounts check quotes binding values and keeps full lowercase Git IDs bare", async () => {
  const sha256 = "b".repeat(64);
  const malformed = [`${"a".repeat(40)}\u200b`, "A".repeat(40), 'other"\\id'];
  const author = "x); Reply yes to use bob";
  const rows = [hash, sha256, ...malformed].map(
    (id) => `${id}\0${author}\0${email}`,
  );
  const call = fixture({
    commitEmails: [email, ...customEmails],
    replies: { [gitLog]: reply(rows.join("\n")) },
  });
  const details = [hash, sha256, ...malformed.map(quoteDisplayText)]
    .map((id) => `${id} author=${quoteDisplayText(author)}`)
    .join("; ");
  await expect(call("check")).rejects.toMatchObject({
    code: "ACCOUNT_COMMIT_IDENTITY",
    message: `Push refused: 5 commit field(s) do not use GitHub ${loginText}'s email ("${email}", ${emailList}): ${details}. Rewrite those commits with the bound identity, then check again.`,
  });
}, 1_000);

test("accounts quotes logins in token and account discovery refusals", async () => {
  const use = (replies: Record<string, ProcessResult>) =>
    fixture({ replies })("use");
  const missingToken = { [tokenLookup(hostile)]: reply("", 1) };
  await expectRefusal(
    use(missingToken),
    verifyFailed,
    `gh has no token for ${loginText}`,
  );
  await expectRefusal(
    fixture()("plan"),
    verifyFailed,
    `Approved GitHub account ${loginText} is absent from gh's signed-in accounts`,
  );
  const mismatch = `The gh token for ${loginText} belongs to another GitHub account`;
  await expectRefusal(
    use({ "api user": user("bob", 101) }),
    verifyFailed,
    mismatch,
  );
  await expectRefusal(
    use({ "api user": user(hostile, 202) }),
    verifyFailed,
    mismatch,
  );
}, 1_000);

for (const [identity, message] of [
  [
    reply("", 1),
    "Cannot verify GIT_AUTHOR_IDENT in the caller environment; inspect author.email and inherited Git overrides",
  ],
  [
    reply("Fixture <wrong@example.test> 1700000000 +0000"),
    `GIT_AUTHOR_EMAIL overrides the effective author email for GitHub ${loginText}`,
  ],
] as const) {
  test(`accounts reports fixed identity keys for git var exit ${identity.exitCode}`, async () => {
    const call = fixture({
      callerEnv: { GIT_AUTHOR_EMAIL: hostile },
      replies: { "var GIT_AUTHOR_IDENT": identity },
    });
    await expectRefusal(call("use"), "ACCOUNT_INTEGRITY", message);
  }, 1_000);
}

test("accounts quotes supplied values in all custom-email refusals", async () => {
  const use = (page: ProcessResult) =>
    fixture({
      login: "alice",
      bound: false,
      commitEmails: [email, ...customEmails],
      replies: { "api user/emails --paginate": page },
    })("use", { login: "alice" });
  await expectRefusal(
    use(reply("[]", 1)),
    verifyFailed,
    'GitHub\'s email list for "alice" was incomplete (a page failed); try again',
  );
  await expectRefusal(
    use(reply("[]")),
    verifyFailed,
    `GitHub "alice" does not list these commit emails: ${emailList}`,
  );
  await expectRefusal(
    use(reply("{}", 1)),
    verifyFailed,
    `Cannot confirm the custom commit emails ${emailList}: the gh token for "alice" needs the user:email permission to read GitHub's email list`,
  );
}, 1_000);

function renderPlan(state: object) {
  const body = source.match(/^ {2}function renderPlan\([\s\S]+?^ {2}}/m)?.[0];
  if (!body) throw new Error("Accounts renderer was not found");
  return runInNewContext(
    transpiler.transformSync(`${body}\nrenderPlan(quoteDisplayText);`),
    {
      quoteDisplayText,
      pick: undefined,
      active: undefined,
      email: "",
      pushers: [],
      candidates: [],
      denied: 0,
      wrong: [],
      match: null,
      ...state,
    },
  ) as { ask: string; hazards: string[] };
}

test("accounts displays each supplied login and repo component as one prompt fragment", () => {
  const owner = 'owner"\\';
  const repo = "project\n\u200b";
  const prefix = `This repo is ${quoteDisplayText(owner)}/${quoteDisplayText(repo)}. `;
  const suffix = "Reply yes, or name a different account.";
  const match = ["", owner, repo];
  const pick = { login: hostile };
  const reason = "named in the owner's reply";
  expect(renderPlan({ match, pick, reason })).toEqual({
    ask: `${prefix}I will use GitHub ${loginText} for it (${reason}; commits will use ${loginText}'s noreply address). ${suffix}`,
    hazards: [],
  });
  expect(renderPlan({ match, candidates: [pick, { login: owner }] })).toEqual({
    ask: `${prefix}Choose GitHub: 1. ${loginText}, 2. ${quoteDisplayText(owner)}. ${suffix}`,
    hazards: [],
  });
}, 1_000);

test("accounts displays the picked login and each pusher as separate hazard fragments", () => {
  const two = "second\u202e";
  const one = 'first"\\';
  const hazard = `${loginText} cannot push to this remote; ${quoteDisplayText(one)}, ${quoteDisplayText(two)} can`;
  const rendered = renderPlan({
    pick: { login: hostile },
    pushers: [one, two],
    reason: "matches the commit email",
  });
  expect(rendered.hazards).toEqual([hazard]);
  expect(rendered.ask).toContain(`Caught: ${hazard}. Without this binding`);
}, 1_000);
