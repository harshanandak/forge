import type { RunSetupCommand } from "../contract/runtime.ts";

export const runSetupCommand: RunSetupCommand = (argv, _deps) => {
  const command = argv[0];
  if (command === "init" || command === "doctor")
    process.stderr.write("not_built: " + command + "\n");
  return Promise.resolve(1);
};
