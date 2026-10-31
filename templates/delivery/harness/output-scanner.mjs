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
export function safeLabel(name, values, deadline = performance.now() + 100) {
  for (const value of values) {
    if (performance.now() > deadline) throw new Error();
    for (let i = 0; i + 8 <= name.length; i++)
      if (value.includes(name.slice(i, i + 8))) return null;
  }
  return name;
}
export function scan(text, key, deadline = performance.now() + 100) {
  const findings = [];
  const budget = () => {
    if (performance.now() > deadline || findings.length >= 4096)
      throw new Error();
  };
  const add = (start, end, family, name) => {
    budget();
    name = name && safeLabel(name, [text.slice(start, end)], deadline);
    findings.push({
      start,
      end,
      family,
      name: name ?? `unknown key (${family})`,
    });
  };
  budget();
  for (const match of text.matchAll(provider)) {
    const value = match[0],
      name = adjacent(text, match.index) ?? safeName(key);
    let family;
    if (value.startsWith("sk-ant-") && value.length >= 27) family = "anthropic";
    else if (
      value.startsWith("sk-") &&
      !value.startsWith("sk-ant-") &&
      (value.length >= 23 ||
        (name && credential.test(name) && value.length >= 11))
    )
      family = "openai";
    else if (
      /^ghp_[A-Za-z0-9]{36}$/.test(value) ||
      /^github_pat_[A-Za-z0-9_]{82}$/.test(value)
    )
      family = "github";
    else if (/^xoxb-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9-]{20,}$/.test(value))
      family = "slack";
    else if (/^AKIA[A-Z0-9]{16}$/.test(value)) family = "aws";
    else if (/^AIza[A-Za-z0-9_-]{35}$/.test(value)) family = "google";
    if (family) add(match.index, match.index + value.length, family, name);
  }
  // Constrain generic detection to the value of this assignment, never a nearby line.
  const assignments =
    /(?<![A-Za-z0-9_.-])["']?([A-Za-z_][A-Za-z0-9_]{0,63})["']?[ \t]*[:=][ \t]*["']?([A-Za-z0-9+/_-]{24,}={0,2})(?![A-Za-z0-9+/_=-])/g;
  for (const match of text.matchAll(assignments)) {
    const name = safeName(match[1]),
      value = match[2];
    if (name && credential.test(name) && generic(value)) {
      const start = match.index + match[0].lastIndexOf(value);
      add(start, start + value.length, "generic", name);
    }
  }
  if (safeName(key) && credential.test(key) && generic(text))
    add(0, text.length, "generic", safeName(key));
  const uris =
    /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/?:#@"<>]+:([^\s/?#@"<>]+)@[^\s/?#@"<>]+/g;
  for (const match of text.matchAll(uris)) {
    const start =
      match.index + match[0].indexOf(":", match[0].indexOf("://") + 3) + 1;
    add(
      start,
      start + match[1].length,
      "uri-password",
      adjacent(text, match.index) ?? safeName(key),
    );
  }
  const merged = [];
  for (const finding of findings.sort(
    (a, b) => a.start - b.start || b.end - a.end,
  )) {
    const previous = merged.at(-1);
    if (previous && finding.start < previous.end) {
      previous.end = Math.max(previous.end, finding.end);
      if (
        previous.name.startsWith("unknown key (") &&
        !finding.name.startsWith("unknown key (")
      )
        previous.name = finding.name;
    } else merged.push({ ...finding });
  }
  budget();
  const parts = [];
  let cursor = 0;
  for (const finding of merged) {
    parts.push(text.slice(cursor, finding.start), "[REDACTED]");
    cursor = finding.end;
  }
  parts.push(text.slice(cursor));
  return { findings: merged, redacted: parts.join("") };
}
