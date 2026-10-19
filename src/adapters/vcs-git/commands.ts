import type { ProcessPort } from "../../ports/process.ts";
import type { ToolCommandPort } from "../../ports/tool-command.ts";

export function createVcsCommandPort(process: ProcessPort): ToolCommandPort {
  return {
    capability: "forge.tool-command/v1",
    ...(process.containment
      ? { containment: () => process.containment!() }
      : {}),
    resolve: (program, env) => process.resolve(program, env),
    async run(program, args, options) {
      const executable = process.resolve(program, options.env);
      return executable.kind === "resolved"
        ? process.run(executable, args, options)
        : executable;
    },
  };
}
