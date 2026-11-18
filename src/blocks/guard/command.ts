import { hookBypass, retiredTracker } from "../project/detect-guard-command.ts";

type HookInput = Record<string, unknown>;
type Dialect = "claude" | "cursor";
interface CommandReply {
  readonly permission?: "deny";
  readonly agent_message?: string;
  readonly user_message?: string;
  readonly systemMessage?: string;
  readonly hookSpecificOutput?: {
    readonly hookEventName: "PreToolUse";
    readonly permissionDecision?: "deny";
    readonly permissionDecisionReason?: string;
    readonly additionalContext?: string;
  };
}
interface Rule {
  readonly id: string;
  readonly action: "block" | "warn";
  readonly test: (command: string) => string | null;
  message(reason: string): string;
}

function object(value: unknown): HookInput | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as HookInput)
    : undefined;
}

export const MAX_COMMAND_LENGTH = 12000;

export function makeBound(limit: number): () => void {
  let count = 0;
  return () => {
    count += 1;
    if (count > limit)
      throw new Error(
        "analysis bound exceeded: the input is too complex to check",
      );
  };
}

const SECRET_PATH =
  /\.agent-secrets|\.zoho[/\\]credentials|credentials\.env|id_rsa|id_ed25519|\.pem\b|\.p12\b|\.env(?!\.(example|sample|template|dist))\b/i;
const GLOBAL_STATE =
  /(?:^|[/\\\s'"])\.+codex-global-state(?:\.json)?(?:[._-][^/\\\s'"]*)?/i;
const HARNESS_STATE_ROOT =
  /(?:^|[/\\])(?:\.codex|\.claude|\.cursor|\.pi(?:[/\\]agent)?|\.config[/\\]opencode|\.local[/\\]share[/\\]opencode|AppData[/\\](?:Roaming|Local)[/\\]Cursor)(?:[/\\]|$)/i;
const HARNESS_STATE_ITEM =
  /(?:^|[/\\])(?:auth(?:entication)?(?:\.json)?|\.?credentials?(?:\.json)?|history(?:\.jsonl?)?|sessions?|archived[_-]?sessions?|backups?|globalStorage|state\.vscdb|rollout-[^/\\]*\.jsonl)(?:[/\\]|\.|$)/i;

const SHORT_NAME_ALIASES: readonly (readonly [RegExp, string])[] = [
  [/^claude~\d+$/i, ".claude"],
  [/^codex~\d+$/i, ".codex"],
  [/^cursor~\d+$/i, ".cursor"],
  [/^pi~\d+$/i, ".pi"],
  [/^agent-~\d+$/i, ".agent-secrets"],
  [/^zoho~\d+$/i, ".zoho"],
  [/^env~\d+$/i, ".env"],
  [/^config~\d+$/i, ".config"],
  [/^local~\d+$/i, ".local"],
  [/^appdat~\d+$/i, "AppData"],
];

function canonicalPath(value: string) {
  const text = value
    .replace(/\\/g, "/")
    .replace(/^\/\/\?\//, "")
    .replace(/^\/mnt\/([a-z])(?=\/|$)/i, "$1:")
    .replace(/^\/([a-z])(?=\/)/i, "$1:");
  const stack: string[] = [];
  const segments = text.split("/");
  const tick = makeBound(segments.length + 8);
  for (const raw of segments) {
    tick();
    if (raw === "" || raw === ".") continue;
    if (raw === "..") {
      if (stack.length && stack.at(-1) !== "..") stack.pop();
      else stack.push("..");
      continue;
    }
    let segment = raw.replace(/[. ]+$/, "") || raw;
    for (const [pattern, name] of SHORT_NAME_ALIASES) {
      if (pattern.test(segment)) {
        segment = name;
        break;
      }
    }
    stack.push(segment);
  }
  return (text.startsWith("/") ? "/" : "") + stack.join("/");
}

function pathForms(value: string) {
  const forms = new Set([value, canonicalPath(value)]);
  if (/\s/.test(value))
    for (const token of lenientWords(value)) forms.add(canonicalPath(token));
  return [...forms];
}

const ALIAS_SEGMENT = /^([^~./\\\s]{2,8})~\d+(?:\.[^./\\]{0,3})?$/;
const ALIAS_STEMS = [
  "agent-secrets",
  "credentials",
  "env",
  "id_rsa",
  "id_ed25519",
];

function hasProtectedAlias(value: string) {
  return value.split(/[/\\]/).some((segment) => {
    const match = ALIAS_SEGMENT.exec(segment);
    if (!match) return false;
    const prefix = match[1]!.toLowerCase();
    return ALIAS_STEMS.some(
      (stem) => stem.startsWith(prefix) || prefix.startsWith(stem),
    );
  });
}

function isProtectedFormOfReadPath(value: string) {
  return (
    SECRET_PATH.test(value) ||
    GLOBAL_STATE.test(value) ||
    hasProtectedAlias(value) ||
    (HARNESS_STATE_ROOT.test(value) && HARNESS_STATE_ITEM.test(value))
  );
}

function isProtectedReadPath(value: string) {
  return pathForms(value).some(isProtectedFormOfReadPath);
}

function reachesWholeHarnessRoot(value: string) {
  const root = HARNESS_STATE_ROOT.exec(value);
  if (!root) return false;
  const rest = value.slice(root.index + root[0].length);
  return (
    /^[/\\]*$/.test(rest) ||
    /^[^/\\]*[*?[]/.test(rest) ||
    /(?:^|[/\\])\.\.(?:[/\\]|$)/.test(rest)
  );
}

function isProtectedSearchPath(value: string) {
  return (
    isProtectedReadPath(value) || pathForms(value).some(reachesWholeHarnessRoot)
  );
}

function lenientWords(value: string) {
  return value
    .split(/\s+/)
    .map((word) => word.replace(/["']/g, ""))
    .filter(Boolean);
}

function shellWords(value: string) {
  const words: string[] = [];
  let word = "";
  let quote: string | null = null;
  const push = () => {
    if (word) words.push(word);
    word = "";
  };
  const tick = makeBound(value.length + 8);
  for (let i = 0; i < value.length; i += 1) {
    tick();
    const char = value[i]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && value[i + 1] === quote) word += value[++i]!;
      else word += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) push();
    else word += char;
  }
  if (quote) return null;
  push();
  return words;
}

const UNCLASSIFIED = "\u0000unclassified";
const PATH_FLAG = /^-{1,2}(?:path|literalpath|f|file)$/i;
const DYNAMIC_VALUE = /\$\(|`|^\(/;

function lenientTargets(operand: string) {
  const words = lenientWords(operand);
  const targets: string[] = [];
  const tick = makeBound(words.length + 8);
  words.forEach((word, index) => {
    tick();
    targets.push(word);
    if (!word.startsWith("-")) return;
    const valued = /^(-{1,2}[A-Za-z][\w-]*)[:=](.*)$/.exec(word);
    const attached = /^-{1,2}[A-Za-z]+(.+)$/.exec(word);
    if (valued?.[2]) targets.push(valued[2]);
    if (attached?.[1]) targets.push(attached[1]);
    const flag = valued?.[1] ?? word;
    const value = valued ? valued[2] : words[index + 1];
    if (PATH_FLAG.test(flag) && value && DYNAMIC_VALUE.test(value))
      targets.push(UNCLASSIFIED);
  });
  return targets;
}

function splitFlagValues(args: string[]) {
  return args.flatMap((arg) => {
    const valued = /^(-{1,2}[A-Za-z][\w-]*)[:=](.+)$/.exec(arg);
    return valued ? [valued[1]!, valued[2]!] : [arg];
  });
}

function searchTargets(verb: string, operand: string) {
  const parsed = shellWords(operand);
  if (!parsed) return lenientTargets(operand);
  const args = splitFlagValues(parsed);
  const name = verb.toLowerCase();
  if (name === "select-string" || name === "sls") {
    const at = args.findIndex((arg) => /^-(?:literal)?path$/i.test(arg));
    return at >= 0
      ? [args[at + 1] ?? ""]
      : args.filter((arg) => !arg.startsWith("-")).slice(1);
  }
  const paths: string[] = [];
  let needsPattern = true;
  const tick = makeBound(args.length + 8);
  for (let i = 0; i < args.length; i += 1) {
    tick();
    const arg = args[i]!,
      lower = arg.toLowerCase();
    if (lower === "--")
      return paths.concat(args.slice(i + (needsPattern ? 2 : 1)));
    if (lower === "--files") {
      needsPattern = false;
      continue;
    }
    if (lower === "-e" || lower === "--regexp") {
      needsPattern = false;
      i += 1;
      continue;
    }
    if (/^-e.+/i.test(arg) || lower.startsWith("--regexp=")) {
      needsPattern = false;
      continue;
    }
    if (lower === "-f" || lower === "--file") {
      paths.push(args[++i] ?? "");
      needsPattern = false;
      continue;
    }
    if (/^-f.+/i.test(arg) || lower.startsWith("--file=")) {
      paths.push(arg.slice(arg.indexOf("=") + 1).replace(/^-f/i, ""));
      needsPattern = false;
      continue;
    }
    if (name === "findstr" && /^\/c:/i.test(arg)) {
      needsPattern = false;
      continue;
    }
    if (name === "findstr" && /^\/g:/i.test(arg)) {
      paths.push(arg.slice(3));
      needsPattern = false;
      continue;
    }
    if (
      /^(?:-g|--glob|--iglob|-t|--type|--type-not|-m|--max-count|--context|--encoding|--engine|--sort|--threads|--type-add|--replace)$/i.test(
        arg,
      ) ||
      /^-[ABCT]$/.test(arg)
    ) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-") || (name === "findstr" && arg.startsWith("/")))
      continue;
    if (needsPattern) needsPattern = false;
    else paths.push(arg);
  }
  return paths;
}

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CRED/i;
const PRINTENV_INVOCATION =
  /(?:^|[;&|\r\n(`])[ \t]*printenv(?=[ \t\r\n;&|)`<>]|$)((?:"(?:\\.|[^"\\])*"|'[^']*'|[^"';&|\r\n)`<>])*)/gi;

function printenvReason(cmd: string): string | null {
  for (const match of cmd.matchAll(PRINTENV_INVOCATION)) {
    const operand = match[1] ?? "";
    const words = shellWords(operand) ?? lenientWords(operand);
    const delimiter = words.indexOf("--");
    const optionsEnd = delimiter === -1 ? words.length : delimiter;
    const beforeDelimiter = words.slice(0, optionsEnd);
    const names = beforeDelimiter
      .filter((word) => !word.startsWith("-"))
      .concat(words.slice(optionsEnd + 1));
    if (
      names.some(
        (name) =>
          SECRET_NAME.test(name) ||
          /COOKIE|DATABASE_URL|DSN|AUTHORIZATION/i.test(name),
      )
    )
      return "credential variable output";
    if (
      names.length === 0 &&
      !beforeDelimiter.some((word) => word === "--help" || word === "--version")
    )
      return "bare env dump";
  }
  return null;
}

const NAME_WORDS = "(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CRED)";
const STATEMENT_START = String.raw`(?:^|[;\n{])[ \t]*\(?[ \t]*`;
const BRACED_NAME = `\\{(?:env:)?[^}\\n]{0,128}${NAME_WORDS}[^}\\n]{0,128}\\}`;
const PLAIN_NAME = `(?:env:)?\\w*${NAME_WORDS}\\w*`;
const VARIABLE_REF = `\\$(?:${BRACED_NAME}|${PLAIN_NAME})`;
const ENV_NAMED = `\\$(?:\\{env:[^}\\n]{0,128}${NAME_WORDS}[^}\\n]{0,128}\\}|env:\\w*${NAME_WORDS}\\w*)`;
const DOTNET_REF = `\\[(?:System\\.)?Environment\\]::GetEnvironmentVariable\\(\\s*['"][^'"\\n]*${NAME_WORDS}`;
const ANY_REF = `(?:${VARIABLE_REF}|${DOTNET_REF})`;
const PRINT_VERB =
  "\\b(?:echo|printf|Write-\\w+|Out-\\w+|Format-\\w+|Set-Clipboard|clip|Tee-Object)\\b";
const ENV_REF_PRINTED = new RegExp(
  `${PRINT_VERB}[\\s\\S]{0,200}${ANY_REF}`,
  "i",
);
const ENV_REF_PIPED = new RegExp(
  `${ANY_REF}[ \\t)"'}\\]]*\\|(?!\\|)|\\|\\s*(?:%|ForEach-Object|foreach)[^;\\n]{0,100}${ANY_REF}`,
  "i",
);
const ENV_REF_BARE = new RegExp(
  `${STATEMENT_START}${ENV_NAMED}(?=[ \\t)"'\\]]*(?:$|[;\\n|.\\[]))`,
  "i",
);
const DOTNET_REF_BARE = new RegExp(`${STATEMENT_START}${DOTNET_REF}`, "i");
const ENV_REF_QUOTED_BARE = new RegExp(
  `${STATEMENT_START}"[^"\\n]*${ENV_NAMED}[^"\\n]*"[ \\t)]*(?:$|[;\\n|])`,
  "i",
);
const ENV_DRIVE = /(?<![\w.${-])env:[\\/]*([^\s'"|;)}\]]*)/gi;
const ENV_DUMP = /\[(?:System\.)?Environment\]::GetEnvironmentVariables\s*\(/i;
const LISTING_VERB =
  /\b(?:Get-ChildItem|gci|dir|ls|Get-Item|gi|Get-Content|gc|cat|type)\b/i;

function envDriveReason(cmd: string) {
  if (ENV_DUMP.test(cmd)) return "bare env dump";
  if (!LISTING_VERB.test(cmd)) return null;
  const tick = makeBound(cmd.length + 8);
  for (const match of cmd.matchAll(ENV_DRIVE)) {
    tick();
    const name = match[1]!;
    if (name === "" || /^\*+$/.test(name)) return "bare env dump";
    if (/[*?[]/.test(name)) return "env listing with a wildcard";
    if (SECRET_NAME.test(name)) return "credential variable output";
  }
  return null;
}

const BRACED_NAME_LIMIT = 128;

function hasUnclassifiableBracedName(cmd: string) {
  const tick = makeBound(cmd.length + 8);
  let from = 0;
  for (;;) {
    tick();
    const open = cmd.indexOf("${", from);
    if (open < 0) return false;
    let end = open + 2;
    while (end < cmd.length && cmd[end] !== "}" && cmd[end] !== "\n") end += 1;
    if (
      end - open - 2 > BRACED_NAME_LIMIT &&
      SECRET_NAME.test(cmd.slice(open + 2, end))
    )
      return true;
    from = end;
  }
}

function envReason(cmd: string) {
  const printed = printenvReason(cmd);
  if (printed) return printed;
  const drive = envDriveReason(cmd);
  if (drive) return drive;
  if (hasUnclassifiableBracedName(cmd))
    return "credential variable name too long to classify";
  const found = [
    ENV_REF_PRINTED,
    ENV_REF_PIPED,
    ENV_REF_BARE,
    DOTNET_REF_BARE,
    ENV_REF_QUOTED_BARE,
  ].some((pattern) => pattern.test(cmd));
  return found ? "credential variable output" : null;
}

const BACKSTOP_VERB =
  /(?<![\w.-])(?:cat|bat|less|more|head|tail|tac|nl|strings|xxd|od|hexdump|type|Get-Content|gc|Get-Item|gi|Import-\w+|ConvertFrom-\w+|rg|grep|egrep|fgrep|findstr|Select-String|sls|sed|awk|base64|sort|cut|paste|jq|echo|printf|Write-\w+|Out-\w+|Format-\w+|Set-Clipboard|clip|Tee-Object|tee)(?![\w.-])/i;
const QUOTED_SPAN = /"(?:\\.|[^"\\])*"|'[^']*'/g;
const QUOTE_MARKER = String.fromCharCode(0);
const QUOTED_INDEX = new RegExp(QUOTE_MARKER + "(\\d+)" + QUOTE_MARKER, "g");
const SOURCING = /(^|[;&|\n({][ \t]*)(?:source|\.)[ \t]+([^\s;&|)]+)/gi;
const WRITE_REDIRECT = /(^|[\s;|&(])\d{0,3}>>?(?!&)[ \t]*([^\s<>;&|)]+)/g;
const EXECUTABLE_OPERAND = /\$\(|`|<\(|>\(/;
const PATH_SPLIT = /[\s'"`()@,;|&<>={}]+/;

function backstopReason(cmd: string) {
  const quoted: string[] = [];
  const masked = cmd.replace(QUOTED_SPAN, (span) => {
    quoted.push(span);
    return `\u0000${quoted.length - 1}\u0000`;
  });
  const restore = (text: string) =>
    text.replace(QUOTED_INDEX, (_, index) => String(quoted[Number(index)]));
  const keepWhenExecutable = (match: string, lead: string, operand: string) =>
    EXECUTABLE_OPERAND.test(restore(operand)) ? match : `${lead} `;
  const withoutBenign = restore(
    masked
      .replace(SOURCING, keepWhenExecutable)
      .replace(WRITE_REDIRECT, keepWhenExecutable),
  );
  if (!BACKSTOP_VERB.test(withoutBenign)) return null;
  const tokens = withoutBenign.split(PATH_SPLIT);
  const tick = makeBound(tokens.length + 8);
  for (const token of tokens) {
    tick();
    if (token !== "" && isProtectedReadPath(token)) {
      return "secret path in a command that reads, searches or prints";
    }
  }
  return null;
}

function continuationVariants(cmd: string) {
  const bashJoined = cmd.replace(/\\\r?\n/g, "");
  const powershellJoined = cmd.replace(/`[ \t]*\r?\n[ \t]*/g, " ");
  return [
    ...new Set([
      cmd,
      bashJoined,
      powershellJoined,
      powershellJoined.replace(/\\\r?\n/g, ""),
    ]),
  ];
}

export const RULES: readonly Rule[] = [
  {
    id: "H1-secrets-bash",
    action: "block",
    test: (original) => {
      if (original.length > MAX_COMMAND_LENGTH)
        return `command too long to check (over ${MAX_COMMAND_LENGTH} characters)`;
      const inspect = (cmd: string) => {
        const tick = makeBound(cmd.length + 64);
        const printInvocation =
          /(^|(?:[;|\n]\s*|&(?!\d)\s*|\$\(\s*|`\s*))(?:cat|bat|less|more|head|tail|nl|strings|xxd|od|type|Get-Content|gc)\b((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^;|&\n]|&(?=\d))*)/gi;
        const searchInvocation =
          /(^|(?:[;|\n]\s*|&(?!\d)\s*|\$\(\s*|`\s*))(rg|grep|findstr|Select-String|sls)\b((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^;|&\n]|&(?=\d))*)/gi;
        const withoutRedirections = (operand: string) => {
          const quoted: string[] = [];
          const protectedOperand = operand.replace(
            /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
            (value) => {
              quoted.push(value);
              return `\u0000${quoted.length - 1}\u0000`;
            },
          );
          const stripped = protectedOperand.replace(
            /(^|[\s;|&(])\d{0,3}>>?(?!&)\s*[^<>;&|\s]*/g,
            "$1 ",
          );
          return stripped.replace(QUOTED_INDEX, (_, index) =>
            String(quoted[Number(index)]),
          );
        };
        for (const match of cmd.matchAll(printInvocation)) {
          tick();
          const printOperand = withoutRedirections(match[2] ?? "");
          if (isProtectedReadPath(printOperand)) return "raw credential output";
        }
        for (const match of cmd.matchAll(searchInvocation)) {
          tick();
          const targets = searchTargets(match[2]!, match[3] ?? "");
          if (targets.includes(UNCLASSIFIED))
            return "unclassifiable search arguments (unbalanced quotes)";
          if (targets.some(isProtectedSearchPath))
            return "raw credential search";
        }

        const backstop = backstopReason(cmd);
        if (backstop) return backstop;

        if (
          /(^|[;&|\n]\s*|\$\(\s*)(env|printenv)[ \t\r]*($|[;&|)\n])/i.test(cmd)
        )
          return "bare env dump";

        const envFound = envReason(cmd);
        if (envFound) return envFound;

        const literal = [
          /\bsk-[A-Za-z0-9_-]{16,}/,
          /\bghp_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bgho_[A-Za-z0-9]{20,}/,
          /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
          /\bAKIA[0-9A-Z]{16}\b/,
          /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
          /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
        ];
        if (literal.some((r) => r.test(cmd))) return "literal credential";
        return null;
      };
      const joined = continuationVariants(original);
      const unquoted = joined.map((text) =>
        text
          .replace(/\\\r?\n/g, "")
          .replace(/\\(?=[A-Za-z_])/g, "")
          .replace(/['"`]/g, ""),
      );
      return (
        [...new Set([...joined, ...unquoted])].map(inspect).find(Boolean) ??
        null
      );
    },
    message: (why) =>
      `BLOCKED — ${why}. Use forge safe-inspect metadata or forge safe-inspect summary; key-name listing of a secret file is blocked and has no helper yet.`,
  },

  {
    id: "H7-hook-bypass",
    action: "block",
    test: hookBypass,
    message: (why) => `BLOCKED — hook bypass (${why}).`,
  },

  {
    id: "H8-live-destructive",
    action: "block",
    test: (cmd) => {
      if (
        /(^|[;&|\r\n]\s*)(sudo\s+)?rm\s+(-[a-z]*r[a-z]*\s+|--recursive\s+)(-\S*\s+)*(?:(?:\/\*?|~)(?=[ \t]*(?:$|[;&|\r\n]))|--no-preserve-root\b)/i.test(
          cmd,
        )
      )
        return "rm -rf against / or ~";
      if (
        /(^|[;&|\r\n]\s*)(mkfs(\.|[\s])|dd\s+[^\r\n]*\bof=\/dev\/)/i.test(cmd)
      )
        return "disk-destructive (mkfs/dd to a device)";
      if (/\bDROP\s+DATABASE\s+\S+/i.test(cmd)) return "DROP DATABASE";
      if (/\bgit\s+push\b[^\n]*--force[^\n]*(main|master|prod)\b/i.test(cmd))
        return "force-push to a protected branch";

      const localPath =
        /(?<=^|[\s'"=(])(?:[A-Za-z]:[\\/]|\/[a-z]\/|~[\\/]|\.{1,2}[\\/])[^\s'"]*/g;
      const liveTag =
        /act_170153044|curapod|\.zoho|neon.*(prod|main)|prod.*neon|n8n.*prod|prod.*n8n/i.test(
          cmd.replace(localPath, " "),
        );
      if (!liveTag) return null;
      const writeVerb =
        /\b(rm|mv|dd|DROP\s+TABLE|DROP\s+DATABASE|DELETE\s+FROM|UPDATE\s+\w+\s+SET|TRUNCATE)\b|curl[^\n]*\s-X\s*(POST|PUT|PATCH|DELETE)|Invoke-RestMethod[^\n]*-Method\s*(Post|Put|Patch|Delete)|psql[^\n]*\s+-c\s+['"](DROP|DELETE|UPDATE|TRUNCATE)/i.test(
          cmd,
        );
      if (writeVerb)
        return "writes to a live system (n8n / Zoho / CuraPod / Meta ads / Neon prod)";
      return null;
    },
    message: (why) => `BLOCKED — ${why}.`,
  },

  {
    id: "H5-worktree",
    action: "warn",
    test: (cmd) =>
      /\bgit\s+(-C\s+\S+\s+)?worktree\s+add\b/i.test(cmd)
        ? "git worktree add"
        : null,
    message: () => "WARN — Forge worktree.",
  },

  {
    id: retiredTracker.id,
    action: "warn",
    test: retiredTracker.test,
    message: () => "WARN ? use Forge.",
  },
  {
    id: "H12-cd-chain",
    action: "warn",
    test: (cmd) =>
      /(^|[;&|]\s*)cd\s+[^\s;&|]+\s*&&/i.test(cmd) ? "cd &&" : null,
    message: () => "WARN — avoid `cd &&`.",
  },
];

export function detectDialect(
  input: HookInput | null,
  forced?: string,
): Dialect {
  if (forced === "claude" || forced === "cursor") return forced;
  if (!input) return "claude";
  return input.hook_event_name === "PreToolUse" ? "claude" : "cursor";
}

function toolName(input: HookInput | null) {
  const raw = input?.tool_name ?? input?.toolName ?? "";
  return typeof raw === "string"
    ? (raw.split(/[.:/]/).at(-1) ?? "").toLowerCase()
    : "";
}

function isShellInput(input: HookInput) {
  const name = toolName(input);
  const payload = object(input.tool_input);
  return (
    /^(?:bash|shell|exec_command|execute_command|run_command|powershell|cmd)$/.test(
      name,
    ) ||
    (!name &&
      [input, payload].some(
        (item) =>
          item &&
          (Object.hasOwn(item, "command") || Object.hasOwn(item, "cmd")),
      ))
  );
}

export function extractCommand(input: HookInput): string {
  for (const item of [object(input.tool_input), input]) {
    for (const key of ["command", "cmd"]) {
      const value = item?.[key];
      if (typeof value === "string") return value;
    }
  }
  return "";
}

function typedAccessReason(input: HookInput) {
  const name = toolName(input);
  const payload = object(input.tool_input ?? input);
  if (!payload) return null;
  const values = (...keys: string[]) =>
    keys
      .flatMap((key): readonly unknown[] => {
        const value = payload[key];
        return Array.isArray(value) ? value : [value];
      })
      .filter((value) => typeof value === "string");
  if (
    /^read(?:_file)?$/.test(name) &&
    values("file_path", "path").some(isProtectedReadPath)
  )
    return "typed credential read";
  if (
    /^(?:grep|search|search_files)$/.test(name) &&
    values("path", "paths", "root", "directory", "cwd").some(
      isProtectedSearchPath,
    )
  )
    return "typed credential search";
  return null;
}

export function evaluateCommand(
  cmd: string,
  rules: readonly Rule[] = RULES,
): {
  blocks: string[];
  warns: string[];
} {
  const blocks: string[] = [];
  const warns: string[] = [];
  for (const rule of rules) {
    let why: string | null;
    try {
      why = rule.test(cmd);
    } catch (error) {
      if (rule.action === "block")
        blocks.push(
          `[${rule.id}] BLOCKED — rule error (${error instanceof Error ? error.message : "unknown"}); the command could not be checked, so it is blocked.`,
        );
      continue;
    }
    if (!why) continue;
    (rule.action === "warn" ? warns : blocks).push(
      `[${rule.id}] ${rule.message(why)}`,
    );
  }
  return { blocks, warns };
}

function denyPayload(dialect: Dialect, reason: string): CommandReply {
  if (dialect === "cursor") {
    return { permission: "deny", agent_message: reason, user_message: reason };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function warnPayload(dialect: Dialect, reason: string): CommandReply {
  if (dialect !== "claude") return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: reason,
    },
    systemMessage: reason,
  };
}

export function checkCommand(value: unknown, forced?: string): CommandReply {
  const input = object(value);
  const dialect = detectDialect(input ?? null, forced);
  if (!input) return denyPayload(dialect, "BLOCKED ? malformed hook input.");
  const typedWhy = typedAccessReason(input);
  if (typedWhy)
    return denyPayload(
      dialect,
      `[H1-secrets-bash] ${RULES[0]!.message(typedWhy)}`,
    );
  if (!isShellInput(input)) return {};
  const command = extractCommand(input);
  if (!command)
    return denyPayload(dialect, "BLOCKED ? unsupported shell payload.");
  const { blocks, warns } = evaluateCommand(command);
  if (blocks.length) return denyPayload(dialect, blocks.join("\n\n"));
  return warns.length ? warnPayload(dialect, warns.join("\n\n")) : {};
}
