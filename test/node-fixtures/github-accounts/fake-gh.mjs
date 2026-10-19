import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const option = (name) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const mode = process.env.FAKE_GH_MODE ?? "ready";
const stored = {
  "alpha-user": { login: "alpha-user", id: 201, name: "Alpha Fixture" },
  "beta-user": { login: "beta-user", id: 202, name: "Beta Fixture" },
};
const tokenFor = (login) =>
  Buffer.from(`fake-credential:${login}`).toString("base64url");
const selected =
  Object.keys(stored).find(
    (login) => process.env.GH_TOKEN === tokenFor(login),
  ) ?? "native";
function log(command, account = selected) {
  if (process.env.FAKE_GH_LOG)
    appendFileSync(
      process.env.FAKE_GH_LOG,
      JSON.stringify({ command, account }) + "\n",
    );
}
function fail() {
  process.stderr.write("fixture authentication failed\n");
  process.exit(1);
}
if (args[0] === "auth" && args[1] === "token") {
  const login = option("--user");
  log("auth.token", login);
  if (
    mode === "auth-failure" ||
    !stored[login] ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN
  )
    fail();
  process.stdout.write(tokenFor(login) + "\n");
} else if (args[0] === "api") {
  const endpoint = args.find((arg) => arg === "user" || arg === "user/emails");
  log(`api.${endpoint ?? "other"}`);
  if (selected === "native") fail();
  const user =
    stored[
      mode === "login-mismatch"
        ? selected === "alpha-user"
          ? "beta-user"
          : "alpha-user"
        : selected
    ];
  const value =
    endpoint === "user/emails"
      ? [
          {
            email: `${user.id}+${user.login}@users.noreply.github.com`,
            verified: true,
            primary: true,
          },
        ]
      : user;
  const jq = option("--jq") ?? option("-q");
  process.stdout.write(
    (jq === ".login"
      ? user.login
      : jq === ".id"
        ? String(user.id)
        : jq === ".name"
          ? user.name
          : JSON.stringify(value)) + "\n",
  );
} else if (args[0] === "repo" && args[1] === "view") {
  log("repo.view");
  if (mode === "repo-denied" || selected === "native") fail();
  process.stdout.write(
    JSON.stringify({
      nameWithOwner:
        args[2] && !args[2].startsWith("-") ? args[2] : "fixture/project",
      viewerPermission: "WRITE",
    }) + "\n",
  );
} else if (args[0] === "pr" && args[1] === "create") {
  log("pr.create");
  process.stdout.write(
    JSON.stringify({
      account: selected,
      number: selected === "alpha-user" ? 1 : 2,
    }) + "\n",
  );
} else if (args[0] === "auth" && args[1] === "switch") {
  log("forbidden-switch");
  process.exit(94);
} else {
  log(args.slice(0, 2).join("."));
  process.stdout.write(JSON.stringify({ account: selected }) + "\n");
}
