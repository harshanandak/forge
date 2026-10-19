import type { ProcessPort } from "../../ports/process.ts";
import type { AccountCommandPort } from "../../ports/tool-command.ts";
import { ForgeFailure } from "../../contract/failure.ts";

export function createGithubCommandPort(
  process: ProcessPort,
): AccountCommandPort {
  return {
    resolve: (program, env) => process.resolve(program, env),
    async run(program, args, options) {
      if (options.credential !== undefined)
        throw new ForgeFailure({
          code: "ACCOUNT_CREDENTIAL_UNSUPPORTED",
          message: "Credential mode is not available",
          retry: "never",
        });
      const executable = process.resolve(program, options.env);
      return executable.kind === "resolved"
        ? process.run(executable, args, options)
        : executable;
    },
  };
}
