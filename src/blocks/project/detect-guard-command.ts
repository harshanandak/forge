export function hookBypass(cmd: string): string | null {
  if (/--no-verify\b/i.test(cmd)) return "--no-verify";
  if (/\bLEFTHOOK\s*=\s*0\b/i.test(cmd)) return "LEFTHOOK=0";
  if (/\bHUSKY(_SKIP_HOOKS)?\s*=\s*0\b/i.test(cmd)) return "HUSKY=0";
  if (/\bSKIP_HOOKS\b|\bSKIP_SIMPLE_GIT_HOOKS\b|--no-hooks\b/i.test(cmd))
    return "a skip-hooks flag";
  if (/\bgit\s+commit\s+(-{1,2}[\w-]+\s+)*-n\b/i.test(cmd))
    return "git commit -n";
  if (/--no-gpg-sign\b|-c\s+commit\.gpgsign\s*=\s*false/i.test(cmd))
    return "a signing bypass";
  return null;
}

export const retiredTracker = {
  id: "H6-beads-retired",
  test: (cmd: string): string | null =>
    /(^|[;&|]\s*|\$\(\s*)bd\s+\w/i.test(cmd) ||
    /\.beads[/\\]|\bbeads\s+(init|sync|import|export)\b/i.test(cmd)
      ? "beads"
      : null,
};
