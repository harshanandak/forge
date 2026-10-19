import type { ProcessPort } from "../../ports/process.ts";
import type { AccountCommandPort } from "../../ports/tool-command.ts";
import { accountEnvironment, renderAccountBootstrap, renderAccountScripts } from "./scripts.ts";

export function createGithubCommandPort(
  process: ProcessPort,
): AccountCommandPort {
  return {
    resolve: (program, env) => process.resolve(program, env),
    async run(program, args, options) {
      const token = Object.entries(options.env).some(([name, value]) => /^(?:gh|github)(?:_enterprise)?_token$/i.test(name) && value !== "");
      const env = options.trustedGitPath !== undefined || token
        ? accountEnvironment(options.env, options.trustedGitPath!, options.trustedConfigPath)
        : options.env;
      const executable = process.resolve(program, env);
      return executable.kind === "resolved"
        ? process.run(executable, args, { ...options, env })
        : executable;
    },
    scripts: renderAccountScripts,
    bootstrap: renderAccountBootstrap,
  };
}
