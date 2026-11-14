import {
  createGithubAppCredential,
  type GithubAppBindings,
  type GithubCredentialPorts,
} from "./github-app-credential.ts";

import {
  mergePolicyBinding,
  readMergePolicy,
  type MergePolicyBindings,
} from "./merge-policy.ts";

/** Ports reserved for server-owned evidence reads; construction performs no I/O. */
export function composeGithub(
  env: unknown,
  ports: GithubCredentialPorts = {
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    deadline: (expire, ms) => {
      const timer = setTimeout(expire, ms);
      return () => clearTimeout(timer);
    },
  },
) {
  const bindings =
    env && typeof env === "object"
      ? (env as GithubAppBindings & MergePolicyBindings)
      : {};
  return {
    ...ports,
    credential: createGithubAppCredential(bindings, ports),
    mergePolicy: () => readMergePolicy(bindings),
    mergePolicyBinding: () => mergePolicyBinding(bindings),
  };
}
