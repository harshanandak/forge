// Run a Bun built-in (`lint` or `fmt`) or fail fast when this Bun build does not have it.
// Usage: bun tools/bun-builtin.ts <lint|fmt> [args...]
// Without the guard, `bun lint` on a Bun that lacks the built-in resolves back to the package.json
// script of the same name and loops forever. Detection reads `bun --help`, which never resolves a
// package script, so the detector cannot recurse.
import { spawnSync } from "node:child_process";

const BUILTINS = {
  lint: "linter",
  fmt: "formatter",
} as const;

export type BuiltinName = keyof typeof BUILTINS;

export interface Runner {
  has(name: BuiltinName): boolean;
  run(name: BuiltinName, args: readonly string[]): number;
}

export function isBuiltinName(value: string | undefined): value is BuiltinName {
  return value !== undefined && Object.hasOwn(BUILTINS, value);
}

export function missingMessage(name: BuiltinName): string {
  return `bun ${name} needs a Bun build with the built-in ${BUILTINS[name]} (currently canary: bun upgrade --canary)`;
}

/** The command list in `bun --help` indents each command by two spaces. */
export function helpListsBuiltin(help: string, name: BuiltinName): boolean {
  return new RegExp(`^ {2}${name}\\s`, "m").test(help);
}

export const bunRunner: Runner = {
  has(name) {
    const help = spawnSync(process.execPath, ["--help"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    return help.status === 0 && helpListsBuiltin(help.stdout, name);
  },
  run(name, args) {
    return (
      spawnSync(process.execPath, [name, ...args], { stdio: "inherit" })
        .status ?? 1
    );
  },
};

export function main(
  argv: readonly string[],
  runner: Runner = bunRunner,
  write: (line: string) => void = (line) => console.error(line),
): number {
  const [name, ...args] = argv;
  if (!isBuiltinName(name)) {
    write("usage: bun tools/bun-builtin.ts <lint|fmt> [args...]");
    return 2;
  }
  if (!runner.has(name)) {
    write(missingMessage(name));
    return 1;
  }
  return runner.run(name, args);
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
