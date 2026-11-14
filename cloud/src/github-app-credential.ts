type Credential = Readonly<{ token: string; expiresAt: number }>;
export type GithubCredentialPorts = Readonly<{
  fetch(url: string, init: RequestInit): Promise<Response>;
  now(): number;
  deadline(expire: () => void, ms: number): () => void;
}>;
export type GithubAppBindings = Readonly<{
  GITHUB_APP_ID?: unknown;
  GITHUB_APP_INSTALLATION_ID?: unknown;
  GITHUB_APP_PRIVATE_KEY?: unknown;
  GITHUB_REPOSITORY_ID?: unknown;
}>;

export function createGithubAppCredential(
  env: GithubAppBindings,
  _ports: GithubCredentialPorts,
): (repositoryId: number, signal: AbortSignal) => Promise<Credential | null> {
  const admitted = bindingId(env.GITHUB_REPOSITORY_ID);
  return (repositoryId, signal) => {
    if (
      signal.aborted ||
      !admitted ||
      repositoryId !== admitted ||
      !bindingId(env.GITHUB_APP_ID) ||
      !bindingId(env.GITHUB_APP_INSTALLATION_ID) ||
      typeof env.GITHUB_APP_PRIVATE_KEY !== "string"
    )
      return Promise.resolve(null);
    return Promise.resolve(null);
  };
}

function bindingId(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^[1-9]\d{0,15}$/.test(value))
    return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : undefined;
}
