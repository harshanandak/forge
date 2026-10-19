import type { ProcessPort } from "../../ports/process.ts";
import type { AccountCommandPort } from "../../ports/tool-command.ts";
import { renderAccountBootstrap, renderAccountScripts } from "./scripts.ts";

export function createGithubCommandPort(
  process: ProcessPort,
): AccountCommandPort {
  return {
    resolve: (program, env) => process.resolve(program, env),
    async run(program, args, options) {
      const executable = process.resolve(program, options.env);
      return executable.kind === "resolved"
        ? process.run(executable, args, options)
        : executable;
    },
    scripts: renderAccountScripts,
    bootstrap: renderAccountBootstrap,
  };
}
