import type {
  AccountBootstrapOptions,
  AccountScriptsOptions,
} from "../../ports/tool-command.ts";
import { ForgeFailure } from "../../contract/failure.ts";

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
  "node_options",
  "node_path",
  "ld_preload",
  "ld_library_path",
  "gconv_path",
  "glibc_tunables",
  "editor",
  "visual",
  "pager",
  "gh_editor",
  "gh_pager",
  "browser",
  "gh_browser",
]);
const EXTERNAL_TOOLS = ["EDITOR", "VISUAL", "PAGER", "GH_EDITOR", "GH_PAGER", "BROWSER", "GH_BROWSER"];
function absolute(path: string): boolean {
  return typeof path === "string" && !/[\0\r\n]/.test(path) && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path);
}
export function trustedGitDirectory(path: string): string {
  const normalized = path?.replace(/\\/g, "/");
  const end = normalized?.lastIndexOf("/");
  if (!absolute(path) || end === undefined || !/^(?:git|git\.exe)$/i.test(normalized.slice(end + 1)))
    throw new ForgeFailure({ code: "ACCOUNT_EXECUTABLE_UNTRUSTED", message: "Configure an absolute Git executable named git or git.exe before routing account commands", retry: "never" });
  return normalized.slice(0, end + (end === 0 || /^[A-Za-z]:\/$/.test(normalized.slice(0, end + 1)) ? 1 : 0));
}
function controlName(name: string): boolean {
  const lower = name.toLowerCase();
  return SECRET_NAMES.has(lower) || lower.startsWith("git_") || lower.startsWith("bash_func_") || lower.startsWith("dyld_");
}
export function accountEnvironment(
  env: Readonly<Record<string, string>>,
  gitPath: string,
  configPath?: string,
): Record<string, string> {
  const directory = trustedGitDirectory(gitPath);
  const selected = Object.fromEntries(Object.entries(env).filter(([name]) => name.toLowerCase() !== "path" && !controlName(name)));
  for (const name of ["GH_TOKEN", "GH_HOST"]) if (env[name] !== undefined) selected[name] = env[name];
  const token = Object.entries(env).some(([name, value]) => /^(?:gh|github)(?:_enterprise)?_token$/i.test(name) && value !== "");
  if (token && (configPath === undefined || !absolute(configPath)))
    throw new ForgeFailure({ code: "ACCOUNT_CONFIG_UNTRUSTED", message: "Token-bearing account commands require an owned empty GitHub configuration directory", retry: "never" });
  if (token) selected.GH_CONFIG_DIR = configPath!;
  selected.PATH = directory;
  if (/^(?:[A-Za-z]:|\/\/)/.test(directory)) selected.PATHEXT = ".EXE";
  for (const name of EXTERNAL_TOOLS) selected[name] = "";
  selected.GIT_TERMINAL_PROMPT = "0";
  selected.GH_PROMPT_DISABLED = "1";
  return selected;
}
function scriptEnvironment(
  options: Pick<
    AccountBootstrapOptions,
    "envPath" | "windows" | "environmentNames"
  >,
): string {
  const names = options.environmentNames.filter(
    (name) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
      !controlName(name),
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
  const directory = trustedGitDirectory(options.gitPath);
  if (!absolute(options.configPath)) throw new ForgeFailure({ code: "ACCOUNT_CONFIG_UNTRUSTED", message: "Account scripts require an owned empty GitHub configuration directory", retry: "never" });
  const scriptPath = options.windows ? directory.replace(/^([A-Za-z]):\//, (_, drive: string) => `/${drive.toLowerCase()}/`) : directory;
  const isolated = `PATH=${shell(scriptPath)}\nexport PATH\n${options.windows ? "PATHEXT=.EXE\nexport PATHEXT\n" : ""}${EXTERNAL_TOOLS.map(name => `${name}=''`).join("\n")}\nexport ${EXTERNAL_TOOLS.join(" ")}\n`;
  const config = options.configPath.replace(/\\/g, "/");
  const emptyConfig = `owned_config=${shell(config)}\n[ ! -L "$owned_config" ] && [ -d "$owned_config" ] || exit 1\nfor entry in "$owned_config"/* "$owned_config"/.[!.]* "$owned_config"/..?*; do\n [ -e "$entry" ] || [ -L "$entry" ] || continue\n [ "$entry" = "$owned_config/.owned" ] && [ ! -L "$entry" ] && [ -f "$entry" ] || exit 1\ndone\nIFS= read -r config_marker < "$owned_config/.owned" || exit 1\n[ "$config_marker" = ${shell(options.marker)} ] || exit 1\n`;
  const native = [options.ghPath, ...options.ghArgs].map(shell).join(" ");
  const selected = `account=$(${shell(options.gitPath)} config --local --get ${shell(options.accountKey)})\n[ "$account" = ${shell(options.account)} ] || exit 1\n`;
  const token = `${emptyConfig}GH_TOKEN=$(${native} auth token --hostname github.com --user "$account" 2>/dev/null) || exit 1\n[ -n "$GH_TOKEN" ] || exit 1\nGH_HOST=github.com\nGH_CONFIG_DIR="$owned_config"\nexport GH_TOKEN GH_HOST GH_CONFIG_DIR\nverified=$(${native} api user --hostname github.com --jq .login 2>/dev/null) || exit 1\n[ "$verified" = "$account" ] || exit 1\n`;
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
    renderAccountBootstrap({ ...options, environmentNames: options.environmentNames.filter(name => name.toLowerCase() !== "path"), body: isolated + body });
  return { router: wrap(router), credential: wrap(credential) };
}
