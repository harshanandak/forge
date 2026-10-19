import type {
  AccountBootstrapOptions,
  AccountScriptsOptions,
} from "../../ports/tool-command.ts";

function shell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
const SECRET_NAMES = new Set([
  "gh_token",
  "github_token",
  "gh_enterprise_token",
  "github_enterprise_token",
  "gh_host",
  "gh_repo",
  "bash_env",
  "env",
  "shellopts",
  "bashopts",
  "zdotdir",
]);
function scriptEnvironment(
  options: Pick<
    AccountBootstrapOptions,
    "envPath" | "windows" | "environmentNames"
  >,
): string {
  const names = options.environmentNames.filter(
    (name) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
      !SECRET_NAMES.has(name.toLowerCase()) &&
      !name.toLowerCase().startsWith("git_") &&
      !name.toLowerCase().startsWith("bash_func_"),
  );
  return `${shell(options.envPath)} -i ${names
    .map((name) => {
      const target = options.windows ? name.toUpperCase() : name;
      const value =
        target === name ? `\${${name}-}` : `\${${name}-\${${target}-}}`;
      return `${target}="${value}"`;
    })
    .join(" ")} GIT_TERMINAL_PROMPT=0 GH_PROMPT_DISABLED=1`;
}

export function renderAccountBootstrap(
  options: AccountBootstrapOptions,
): string {
  return `#!/bin/sh\n${options.marker}\nexec ${scriptEnvironment(options)} ${shell(options.shellPath)} -c ${shell(`set -eu\n${options.body}`)} forge-account "$@"\n`;
}

/** The absolute Git shell bootstrap transfers argv to the explicitly pinned interpreter. */
export function renderAccountScripts(options: AccountScriptsOptions): {
  readonly router: string;
  readonly credential: string;
} {
  const native = [options.ghPath, ...options.ghArgs].map(shell).join(" ");
  const selected = `account=$(${shell(options.gitPath)} config --local --get ${shell(options.accountKey)})\n[ "$account" = ${shell(options.account)} ] || exit 1\n`;
  const token = `GH_TOKEN=$(${native} auth token --hostname github.com --user "$account" 2>/dev/null) || exit 1\n[ -n "$GH_TOKEN" ] || exit 1\nGH_HOST=github.com\nexport GH_TOKEN GH_HOST\nverified=$(${native} api user --hostname github.com --jq .login 2>/dev/null) || exit 1\n[ "$verified" = "$account" ] || exit 1\n`;
  const allowed =
    options.allowedGhCommands
      .filter(
        (prefix) =>
          !["auth", "alias", "config", "extension", "secret"].includes(
            prefix.split(" ")[0]!,
          ),
      )
      .map((prefix) => shell(prefix.replace(" ", ":")))
      .join("|") || "''";
  const router = `${selected}case "\${1:-}:\${2:-}" in ${allowed}) ;; *) exit 1;; esac\nfor argument in "$@"; do case "$argument" in --hostname|--hostname=*|--repo|--repo=*|--header|--header=*|-R*|-H*) exit 1;; esac; done\n${token}exec ${native} "$@"\n`;
  const credential = `[ "\${1:-}" = get ] || exit 0\nprotocol=; host=\nwhile IFS= read -r line && [ -n "$line" ]; do case "$line" in protocol=*) protocol=\${line#protocol=};; host=*) host=\${line#host=};; esac; done\n[ "$protocol" = https ] && [ "$host" = github.com ] || exit 0\n${selected}${token}printf 'username=%s\\npassword=%s\\n\\n' "$account" "$GH_TOKEN"\n`;
  const wrap = (body: string): string =>
    renderAccountBootstrap({ ...options, body });
  return { router: wrap(router), credential: wrap(credential) };
}
