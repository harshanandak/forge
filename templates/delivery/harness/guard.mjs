// Command-text guard derived from agent-config's guard-bash.js. Never execute input.
import { readFileSync } from "node:fs";

const reasons = {
  "env-dump": "Request one ordinary variable explicitly.",
  "secret-variable":
    "Test whether the secret is present instead of printing it.",
  "secret-file": "Inspect a redacted example instead of credential contents.",
  "provider-env":
    "Use presence checks instead of listing provider secret values.",
  "rm-root":
    "Choose a specific project directory instead of a root or home directory.",
  "unsupported-payload": "The shell command must be a string.",
};

function segments(text) {
  const result = [];
  let words = [],
    word = "",
    started = false,
    quote = "";
  const frames = [];
  const flushWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const flush = () => {
    flushWord();
    if (words.length) result.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i],
      next = text[i + 1];
    if (
      c === "\\" &&
      quote !== "'" &&
      (!quote || /["\\$`\n]/.test(next ?? ""))
    ) {
      started = true;
      word += next ?? "\\";
      i++;
      continue;
    }
    if (quote === "'") {
      if (c === quote) quote = "";
      else word += c;
      continue;
    }
    if (c === "$" && next === "(") {
      flush();
      frames.push({ quote, close: ")" });
      quote = "";
      i++;
      continue;
    }
    if (c === "`") {
      flush();
      if (frames.at(-1)?.close === "`") quote = frames.pop().quote;
      else {
        frames.push({ quote, close: "`" });
        quote = "";
      }
      continue;
    }
    if (!quote && c === "(") {
      flush();
      frames.push({ quote: "", close: ")" });
      continue;
    }
    if (!quote && c === ")") {
      flush();
      // Only the matching substitution restores its surrounding quote.
      if (frames.at(-1)?.close === ")") quote = frames.pop().quote;
      continue;
    }
    if (c === quote) {
      quote = "";
      continue;
    }
    if (!quote && (c === "'" || c === '"')) {
      quote = c;
      started = true;
      continue;
    }
    if (!quote && c === "#" && !started) {
      while (i < text.length && text[i] !== "\n") i++;
      flush();
      continue;
    }
    if (!quote && /[;&|\n]/.test(c)) {
      flush();
      continue;
    }
    if (!quote && /[<>]/.test(c)) {
      if (/^\d+$/.test(word)) {
        word = "";
        started = false;
      }
      flushWord();
      words.push(c);
      if (next === c) i++;
      continue;
    }
    if (!quote && /\s/.test(c)) {
      flushWord();
      continue;
    }
    started = true;
    word += c;
  }
  flush();
  return result;
}
const name = (word) => (word ?? "").split(/[\\/]/).pop().toLowerCase();
const assignment = (word) => /^[A-Za-z_][\w]*=/.test(word ?? "");
const secret = (word) => /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CRED/i.test(word);
function secretPath(word) {
  const path = word.replaceAll("\\", "/"),
    base = name(path);
  return (
    (/^\.env(?:\.|$)/i.test(base) &&
      !/\.(example|sample|template|dist)$/i.test(base)) ||
    /^(id_rsa|id_ed25519|id_ecdsa|id_dsa|credentials|credentials\.json|\.credentials\.json|\.git-credentials|\.netrc)$/i.test(
      base,
    ) ||
    /\.(pem|p12|pfx|key)$/i.test(base) ||
    /(?:^|\/)\.codex\/auth\.json$/i.test(path) ||
    /\/proc\/[^/]+\/environ$/i.test(path)
  );
}
function normalized(path) {
  path = path.replaceAll("\\", "/").replace(/^\/([a-z])(?=\/|$)/i, "$1:");
  while (/\/(?:\*|\.)?$/.test(path)) path = path.replace(/\/(?:\*|\.)?$/, "");
  return process.platform === "win32" ? path.toLowerCase() : path;
}
function rootOrHome(path) {
  const value = normalized(path);
  return (
    value === "" ||
    /^[a-z]:$/i.test(value) ||
    /^~[^/]*$/.test(value) ||
    /^\$(?:HOME|\{HOME\})$/i.test(value) ||
    [process.env.HOME, process.env.USERPROFILE].some(
      (home) => home && value === normalized(home),
    )
  );
}
function check(words, depth) {
  const inputs = words.flatMap((word, index) =>
    word === "<" && words[index + 1] !== undefined ? [words[index + 1]] : [],
  );
  // Redirection targets are not command operands; input targets still need the reader check.
  words = words.filter(
    (word, index) =>
      !["<", ">"].includes(word) && !["<", ">"].includes(words[index - 1]),
  );
  let i = 0;
  const flags = (takesValue = []) => {
    while (words[i]?.startsWith("-")) {
      const flag = words[i++];
      if (flag === "--") break;
      if (takesValue.includes(flag)) i++;
    }
  };
  while (i < words.length) {
    const cmd = name(words[i]);
    if (
      assignment(words[i]) ||
      /^(?:!|\{|\}|if|then|else|elif|do|while|until)$/.test(cmd)
    ) {
      i++;
      continue;
    }
    if (cmd === "env") {
      i++;
      flags(["-u", "--unset"]);
      while (assignment(words[i])) i++;
      if (i === words.length) return "env-dump";
      continue;
    }
    if (/^(sudo|doas|command|builtin|exec|nohup|time|npx|bunx)$/.test(cmd)) {
      i++;
      flags(["-u", "-g", "--user", "--group"]);
      continue;
    }
    if (
      /^(pnpm|npm|yarn)$/.test(cmd) &&
      /^(dlx|exec)$/.test(words[i + 1] ?? "")
    ) {
      i += 2;
      flags();
      continue;
    }
    break;
  }
  const cmd = name(words[i++]),
    args = words.slice(i);
  if (/^(sh|bash|zsh|dash)$/.test(cmd) && depth < 3) {
    const option = args.findIndex((arg) => /^-[^-]*c/.test(arg));
    if (option >= 0 && args[option + 1] !== undefined)
      return inspect(args[option + 1], depth + 1);
  }
  const operands = args.filter((arg) => !arg.startsWith("-"));
  if (
    (cmd === "printenv" && operands.length === 0) ||
    (cmd === "set" && !args.length) ||
    (cmd === "export" && args.every((arg) => arg === "-p")) ||
    (/^(declare|typeset)$/.test(cmd) &&
      args.every((arg) => /^-[px]+$/.test(arg)))
  )
    return "env-dump";
  if (
    ((cmd === "printenv" ||
      (cmd === "declare" && args.some((arg) => /^-[^-]*p/.test(arg)))) &&
      operands.some(secret)) ||
    (/^(echo|printf)$/.test(cmd) &&
      args.some((arg) =>
        [...arg.matchAll(/\$\{?([A-Za-z_]\w*)/g)].some((match) =>
          secret(match[1]),
        ),
      ))
  )
    return "secret-variable";
  if (
    /^(cat|bat|tac|nl|less|more|head|tail|strings|xxd|od|hexdump|base64|grep|egrep|fgrep|rg|awk|sed|cut|sort|jq)$/.test(
      cmd,
    ) &&
    [...args, ...inputs].some((arg) => !arg.startsWith("-") && secretPath(arg))
  )
    return "secret-file";
  const provider = operands.join(" ");
  if (
    (cmd === "convex" && /^env (list|get)( |$)/.test(provider)) ||
    (cmd === "heroku" && /^config(?::get)?( |$)/.test(provider)) ||
    (cmd === "netlify" && /^env:(list|get)( |$)/.test(provider)) ||
    (cmd === "railway" && /^variables( |$)/.test(provider)) ||
    (cmd === "doppler" && /^secrets( |$)/.test(provider))
  )
    return "provider-env";
  if (cmd === "rm") {
    const end = args.indexOf("--"),
      options = end < 0 ? args : args.slice(0, end);
    const targets =
      end < 0
        ? operands
        : [
            ...options.filter((arg) => !arg.startsWith("-")),
            ...args.slice(end + 1),
          ];
    if (
      options.includes("--no-preserve-root") ||
      (options.some(
        (arg) => arg === "--recursive" || /^-[^-]*[rR]/.test(arg),
      ) &&
        targets.some(rootOrHome))
    )
      return "rm-root";
  }
}
function inspect(text, depth = 0) {
  for (const words of segments(text)) {
    const rule = check(words, depth);
    if (rule) return rule;
  }
}
let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
if (
  !payload ||
  typeof payload !== "object" ||
  Array.isArray(payload) ||
  payload.tool_name !== "Bash"
)
  process.exit(0);
const rule =
  typeof payload.tool_input?.command === "string"
    ? inspect(payload.tool_input.command)
    : "unsupported-payload";
if (rule) {
  process.stderr.write(`Forge guard refused (${rule}): ${reasons[rule]}\n`);
  process.exit(2);
}
