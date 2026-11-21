export const optionalJourneyVariables = [
  "COMSPEC",
  "FORGE_NODE26",
  "FORGE_PACKED_CONSUMER",
  "FORGE_PACK_EXPECTED_RUN_ID",
  "FORGE_PACK_EXPECTED_SHA256",
  "FORGE_RELEASE_ACCEPTANCE",
  "GITHUB_RUN_ID",
  "NODE_OPTIONS",
  "PATH",
  "PATHEXT",
  "Path",
  "ProgramFiles",
  "STATE_NODE26",
  "STATE_NODE_LEG",
  "SYSTEMROOT",
  "SystemRoot",
] as const;

export function optionalJourneyEnv(
  name: (typeof optionalJourneyVariables)[number],
): string | undefined {
  return process.env[name];
}

export function requireJourneyEnv(name: string, message: string): string {
  const value = process.env[name];
  if (!value) throw new Error(message);
  return value;
}

export function journeyChildEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}
