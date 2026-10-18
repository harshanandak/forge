import { envValue } from "./env.ts";
import { ProcessSpawnError } from "./errors.ts";
import { pathFor, type Platform } from "./platform.ts";

export interface SpawnPlan {
  readonly file: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
}

const BATCH_EXTENSIONS = new Set([".cmd", ".bat"]);

/**
 * Characters that cannot be carried safely through cmd.exe. Everything else is wrapped in double
 * quotes, inside which cmd treats & | < > ^ ( ) literally. A quote would end that quoting and `%`
 * is expanded by cmd even inside quotes, so both are refused rather than escaped.
 */
const UNSAFE_FOR_BATCH = /["%\r\n\0]/;

function quoteForBatch(value: string, what: string): string {
  if (UNSAFE_FOR_BATCH.test(value)) {
    throw new ProcessSpawnError(
      "UNSAFE_ARGUMENT",
      `Refusing to pass ${what} ${JSON.stringify(value)} through cmd.exe: it holds a quote, percent sign or line break that cmd would reinterpret.`,
    );
  }
  // The program that finally reads this treats a backslash run before the closing quote as an escape.
  return `"${value.replace(/(\\+)$/, "$1$1")}"`;
}

function commandInterpreter(
  env: Readonly<Record<string, string>>,
  platform: Platform,
): string {
  const explicit = envValue(env, "ComSpec", platform);
  if (explicit !== undefined && explicit !== "") return explicit;
  const root = envValue(env, "SystemRoot", platform);
  return root === undefined || root === ""
    ? "cmd.exe"
    : pathFor(platform).join(root, "System32", "cmd.exe");
}

/**
 * How to start a resolved executable with these arguments.
 *
 * Programs start directly with an argument array. A Windows `.cmd` or `.bat` shim cannot: Node
 * refuses to start one without a shell since CVE-2024-27980, and before that fix the same shim
 * failed with ENOENT (old issues 9997d516 and c4393667). Those go through
 * `cmd.exe /d /s /c` with every argument quoted and the unsafe characters refused, so no
 * argument can become a second command.
 */
export function planSpawn(
  executable: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  platform: Platform,
): SpawnPlan {
  for (const arg of args) {
    if (typeof arg !== "string" || arg.includes("\0")) {
      throw new ProcessSpawnError(
        "UNSAFE_ARGUMENT",
        "Arguments must be strings without NUL characters.",
      );
    }
  }
  const batch =
    platform === "win32" &&
    BATCH_EXTENSIONS.has(pathFor(platform).extname(executable).toLowerCase());
  if (!batch) {
    return { file: executable, args, windowsVerbatimArguments: false };
  }
  const line = [
    quoteForBatch(executable, "the program path"),
    ...args.map((arg) => quoteForBatch(arg, "the argument")),
  ].join(" ");
  return {
    file: commandInterpreter(env, platform),
    args: ["/d", "/v:off", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}
