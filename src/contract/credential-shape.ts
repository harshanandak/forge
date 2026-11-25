const KNOWN_CREDENTIAL_PATTERN =
  /^(?:ghp_|github_pat_|sk-|xoxb-|AKIA|AIza)[A-Za-z0-9_-]+$/;

export function hasDeviceCredential(value: string): boolean {
  return /fct_/i.test(value);
}

export function redactCredentialArgument(value: string): string {
  if (hasDeviceCredential(value)) {
    return "[redacted]";
  }
  if (KNOWN_CREDENTIAL_PATTERN.test(value)) {
    return "[redacted]";
  }
  return value;
}
