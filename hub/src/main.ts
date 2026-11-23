import { runSetupCommand } from "./setup/index.ts";

export async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];
  if (command === "init" || command === "doctor")
    return Promise.resolve(runSetupCommand(argv));
  process.stderr.write("usage: forge-hub <command>\n");
  return 2;
}
