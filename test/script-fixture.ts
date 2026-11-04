import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Script } from "node:vm";

// Run the unchanged script body with isolated stdio and exit, without a child per case.
export function scriptFixture(path: string) {
  const source = readFileSync(path, "utf8");
  const program = new Script(
    source.replace(/^import \{[^}]+\} from "node:fs";\r?\n/m, ""),
    { filename: path },
  );
  return (
    input: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd: string,
  ) => {
    let status = 0,
      stdout = "",
      stderr = "";
    const exited = new Error("Fixture process exited");
    try {
      program.runInNewContext({
        readFileSync: (file: string | number) =>
          file === 0 ? input : readFileSync(resolve(cwd, String(file)), "utf8"),
        writeFileSync: (file: string, text: string) =>
          writeFileSync(resolve(cwd, file), text),
        console: {
          log: (text: string) => {
            stdout += `${text}\n`;
          },
          error: (text: string) => {
            stderr += `${text}\n`;
          },
        },
        process: {
          argv: ["node", path, ...args],
          env,
          platform: process.platform,
          stderr: {
            write: (text: string) => {
              stderr += text;
            },
          },
          exit: (code: number) => {
            status = code;
            throw exited;
          },
        },
      });
    } catch (error) {
      if (error !== exited) throw error;
    }
    return { status, stdout, stderr };
  };
}
