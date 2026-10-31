// Original heuristics informed by Gitleaks (MIT, Copyright 2019 Zachary Rice):
// anthropic-api-key, openai-api-key, github-pat, github-fine-grained-pat,
// slack-bot-token, aws-access-token, gcp-api-key, generic-api-key.
// https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml
// URI userinfo follows RFC 3986 section 3.2.1 (https://www.rfc-editor.org/rfc/rfc3986).
const credential = /KEY|TOKEN|SECRET|PASSWORD/i;
const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const generic = (value) =>
  !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value) &&
  (/^[a-f0-9]+$/i.test(value)
    ? value.length >= 32
    : /^[A-Za-z0-9+/_-]{24,}={0,2}$/.test(value));
const provider =
  /(?<![A-Za-z0-9_-])(?:sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|xoxb-[A-Za-z0-9-]+|AKIA[A-Z0-9]+|AIza[A-Za-z0-9_-]+)(?![A-Za-z0-9_-])/g;
function safeName(name) {
  return typeof name === "string" &&
    identifier.test(name) &&
    !/sk-|ghp_|github_pat_|xoxb-|AKIA|AIza/.test(name)
    ? name
    : null;
}
function adjacent(text, start) {
  const offset = Math.max(0, start - 128);
  const match =
    /(?:^|[\s{,;])["']?([A-Za-z_][A-Za-z0-9_]{0,63})["']?[ \t]*[:=][ \t]*["']?$/.exec(
      text.slice(offset, start),
    );
  return match && !(offset && match.index === 0) ? safeName(match[1]) : null;
}
export function scan(text, key, deadline = performance.now() + 100) {
  const budget = () => {
    if (performance.now() > deadline) throw new Error();
  };
  budget();
  for (const match of text.matchAll(provider)) {
    budget();
    const value = match[0],
      name = adjacent(text, match.index) ?? safeName(key);
    if (
      (value.startsWith("sk-ant-") && value.length >= 27) ||
      (value.startsWith("sk-") &&
        !value.startsWith("sk-ant-") &&
        (value.length >= 23 ||
          (name && credential.test(name) && value.length >= 11))) ||
      /^ghp_[A-Za-z0-9]{36}$/.test(value) ||
      /^github_pat_[A-Za-z0-9_]{82}$/.test(value) ||
      /^xoxb-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9-]{20,}$/.test(value) ||
      /^AKIA[A-Z0-9]{16}$/.test(value) ||
      /^AIza[A-Za-z0-9_-]{35}$/.test(value)
    )
      return true;
  }
  // Constrain generic detection to the value of this assignment, never a nearby line.
  const assignments =
    /(?<![A-Za-z0-9_.-])["']?([A-Za-z_][A-Za-z0-9_]{0,63})["']?[ \t]*[:=][ \t]*["']?([A-Za-z0-9+/_-]{24,}={0,2})(?![A-Za-z0-9+/_=-])/g;
  for (const match of text.matchAll(assignments)) {
    budget();
    const name = safeName(match[1]),
      value = match[2];
    if (name && credential.test(name) && generic(value)) return true;
  }
  budget();
  if (safeName(key) && credential.test(key) && generic(text)) return true;
  const uris =
    /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/?:#@"<>]+:([^\s/?#@"<>]+)@[^\s/?#@"<>]+/g;
  for (const _match of text.matchAll(uris)) {
    budget();
    return true;
  }
  budget();
  return false;
}
