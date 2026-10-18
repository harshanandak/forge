import { builtinModules } from "node:module";
import type { SourceFile, Violation } from "./repo.ts";
import { CODE_FILE, isTestFile } from "./repo.ts";

/** Code that must stay pure: it reaches the OS only through a port, never by importing a platform module. */
export const PURE_PREFIXES: readonly string[] = [
  "src/core/",
  "src/contract/",
  "src/ports/",
];

export function isPureFile(path: string): boolean {
  return (
    CODE_FILE.test(path) &&
    !isTestFile(path) &&
    PURE_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}

interface ModuleRule {
  readonly allowed: boolean;
  readonly reason: string;
}

const deny = (reason: string): ModuleRule => ({ allowed: false, reason });
const allow = (reason: string): ModuleRule => ({ allowed: true, reason });

/**
 * The one table. Key is the module with `node:` and any subpath removed (`node:fs/promises` is `fs`).
 * A Node built-in missing from the table is denied: add it here, with a reason, once it is known pure.
 */
export const NODE_MODULES: ReadonlyMap<string, ModuleRule> = new Map([
  ["fs", deny("file access goes through a port")],
  [
    "path",
    deny("path.resolve reads the working directory; take paths as data"),
  ],
  ["os", deny("host facts (home, tmp, platform) come from a port")],
  ["child_process", deny("spawning is the process port")],
  ["worker_threads", deny("threads are an adapter concern")],
  ["net", deny("network access goes through a port")],
  ["http", deny("network access goes through a port")],
  ["https", deny("network access goes through a port")],
  ["http2", deny("network access goes through a port")],
  ["tls", deny("network access goes through a port")],
  ["dgram", deny("network access goes through a port")],
  ["dns", deny("network access goes through a port")],
  ["cluster", deny("process management is an adapter concern")],
  ["process", deny("ambient process state is an explicit argument or a port")],
  [
    "url",
    deny(
      "fileURLToPath and pathToFileURL are file helpers; use the global URL",
    ),
  ],
  ["module", deny("createRequire loads code from disk")],
  ["readline", deny("terminal input is a surface concern")],
  ["tty", deny("terminal state is a surface concern")],
  ["v8", deny("runtime internals")],
  ["vm", deny("runtime internals")],
  ["inspector", deny("runtime internals")],
  ["perf_hooks", deny("time comes from the clock port")],
  ["sqlite", deny("storage is the store port")],
  ["assert", deny("tests only; core fails with a typed failure")],
  ["crypto", allow("hashing and digests are pure computation")],
  ["util", allow("types and formatting only")],
  ["events", allow("in-memory emitter")],
  ["buffer", allow("in-memory bytes")],
  ["string_decoder", allow("in-memory text decoding")],
  ["async_hooks", allow("in-memory context propagation")],
]);

const BUILTINS = new Set(
  builtinModules.map((m) => m.replace(/^node:/, "").split("/")[0]),
);

/** `process.<member>` reads that make a result depend on the host; broader than this hits a port parameter named `process`. */
export const PROCESS_MEMBERS: readonly string[] = [
  "cwd",
  "env",
  "argv",
  "platform",
  "exit",
  "stdin",
  "stdout",
  "stderr",
  "hrtime",
  "pid",
];

/** Blank out comments (and, when asked, string contents) so patterns match code only; positions and newlines are kept. */
export function maskSource(text: string, maskStrings: boolean): string {
  const out: string[] = [];
  const blank = (ch: string): string => (ch === "\n" || ch === "\r" ? ch : " ");
  const literal = (chars: string): string =>
    maskStrings ? [...chars].map(blank).join("") : chars;
  // Brace depth at each open `${`, so the template resumes at the matching `}`.
  const resume: number[] = [];
  let depth = 0;
  let inTemplate = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (inTemplate) {
      if (ch === "\\") {
        out.push(literal(ch + next));
        i += 2;
      } else if (ch === "`") {
        out.push(ch);
        inTemplate = false;
        i += 1;
      } else if (ch === "$" && next === "{") {
        out.push("${");
        resume.push(depth);
        depth += 1;
        inTemplate = false;
        i += 2;
      } else {
        out.push(literal(ch));
        i += 1;
      }
    } else if (ch === "/" && next === "/") {
      while (i < n && text[i] !== "\n") {
        out.push(" ");
        i += 1;
      }
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out.push([...text.slice(i, stop)].map(blank).join(""));
      i = stop;
    } else if (ch === "'" || ch === '"') {
      out.push(ch);
      i += 1;
      while (i < n && text[i] !== ch && text[i] !== "\n") {
        const escaped = text[i] === "\\" && i + 1 < n;
        out.push(
          literal(
            escaped ? (text[i] ?? "") + (text[i + 1] ?? "") : (text[i] ?? ""),
          ),
        );
        i += escaped ? 2 : 1;
      }
      if (text[i] === ch) {
        out.push(ch);
        i += 1;
      }
    } else if (ch === "`") {
      out.push(ch);
      inTemplate = true;
      i += 1;
    } else {
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (resume[resume.length - 1] === depth) {
          resume.pop();
          inTemplate = true;
        }
      }
      out.push(ch);
      i += 1;
    }
  }
  return out.join("");
}

interface Found {
  readonly specifier: string;
  readonly form: string;
  readonly line: number;
}

const lineOf = (text: string, index: number): number =>
  text.slice(0, index).split("\n").length;

/** Every module a file names, in any form: static, side-effect, re-export, dynamic `import()` and `require()`. */
function namedModules(code: string): Found[] {
  const found: Found[] = [];
  const add = (regex: RegExp, form: string): void => {
    for (const match of code.matchAll(regex)) {
      const specifier = match[1];
      if (specifier !== undefined)
        found.push({ specifier, form, line: lineOf(code, match.index ?? 0) });
    }
  };
  add(/\b(?:import|export)\b[^;'"`]*?\bfrom\s*["']([^"']+)["']/g, "import");
  add(/\bimport\s*["']([^"']+)["']/g, "import");
  add(/\bimport\s*\(\s*["']([^"']+)["']\s*[,)]/g, "dynamic import()");
  add(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, "require()");
  return found;
}

function judge(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("#")) return undefined;
  if (specifier === "bun" || specifier.startsWith("bun:")) {
    return "Bun APIs belong in an adapter; core runs on any runtime";
  }
  const bare = specifier.replace(/^node:/, "");
  const root = bare.split("/")[0] ?? bare;
  const rule = NODE_MODULES.get(root);
  if (rule !== undefined) return rule.allowed ? undefined : rule.reason;
  if (BUILTINS.has(root)) {
    return `"${root}" is not on the pure-module list in test/structure/lib/platform.ts; add it there with a reason if it is pure`;
  }
  return undefined;
}

/** Core, contract and ports import no platform module and read no ambient process state. */
export function findPlatformViolations(
  files: readonly SourceFile[],
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files.filter((f) => isPureFile(f.path))) {
    const report = (line: number, message: string): void => {
      violations.push({
        rule: "platform-boundary",
        file: file.path,
        line,
        message,
      });
    };
    const withStrings = maskSource(file.text, false);
    const codeOnly = maskSource(file.text, true);

    for (const { specifier, form, line } of namedModules(withStrings)) {
      const why = judge(specifier);
      if (why !== undefined) {
        report(
          line,
          `${form} of "${specifier}": ${why}; reach the OS through a port in src/ports implemented under src/adapters`,
        );
      }
    }
    for (const match of codeOnly.matchAll(
      /\b(?:import|require)\s*\(\s*(?!["'`])/g,
    )) {
      report(
        lineOf(codeOnly, match.index ?? 0),
        "dynamic import or require with a computed specifier cannot be checked; name the module literally",
      );
    }
    for (const match of codeOnly.matchAll(
      /\b(?:getBuiltinModule|createRequire)\b/g,
    )) {
      report(
        lineOf(codeOnly, match.index ?? 0),
        `"${match[0]}" loads platform modules past the import check`,
      );
    }
    const members = PROCESS_MEMBERS.join("|");
    for (const match of codeOnly.matchAll(
      new RegExp(`\\bprocess\\s*(?:\\?\\.|\\.)\\s*(${members})\\b`, "g"),
    )) {
      report(
        lineOf(codeOnly, match.index ?? 0),
        `reads process.${match[1]}; take it as an explicit argument or through a port`,
      );
    }
    for (const match of codeOnly.matchAll(/\bBun\s*(?:\?\.|\.)\s*\w+/g)) {
      report(
        lineOf(codeOnly, match.index ?? 0),
        `uses the Bun global (${match[0].replace(/\s+/g, "")}); Bun APIs belong in an adapter`,
      );
    }
  }
  return violations;
}
