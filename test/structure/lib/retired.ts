import { DETECTOR_MODULE, type SourceFile, type Violation } from "./repo.ts";

/** Paths where retired names may legitimately appear (recognition and fixtures), plus the denylist itself. */
export const RETIRED_EXEMPT: readonly RegExp[] = [
  /^test\/structure\//,
  /^src\/blocks\/migrate\/legacy\//,
  DETECTOR_MODULE,
  /(?:^|\/)fixtures\//,
  /(?:^|\/)bun\.lock$/,
  /^LICENSE$/,
];

interface Pattern {
  readonly name: string;
  readonly regex: RegExp;
}

const p = (name: string, regex: RegExp): Pattern => ({ name, regex });

/** The DROP list as lexical patterns. Retirement is total: no names, shims or docs of a removed feature. */
export const RETIRED_CONTENT: readonly Pattern[] = [
  p("beads", /\bbeads\b/i),
  p("bd", /\bbd\b/i),
  p("dolt", /\bdolt\b/i),
  p("FORGE_ISSUE_BACKEND", /FORGE_ISSUE_BACKEND/i),
  p("issue-backend", /issue-backend/i),
  p("D20 kill-list", /\bD20\b/i),
  p("/check command", /(?:^|[\s`"'(])\/check\b/),
  p("premerge", /\bpremerge\b/i),
  p("smart-status", /smart-status/i),
  p("forge-team", /forge-team/i),
  p("pr-coordinator", /pr-coordinator/i),
  p("beta5", /\bbeta5\b/i),
  p("KAP-*", /\bKAP-/),
  p("rail.*", /\brail\.[a-z*]/i),
  p("forge-full-suite", /forge-full-suite/i),
  p("shepherd", /shepherd/i),
  p("kernel", /\bkernel\b/i),
  p("Forge Contracts/Flow", /\bforge[\s/-]?(?:contracts|flow)\b/i),
  p("dashboard", /\bdashboard\b/i),
  p("cockpit", /\bcockpit\b/i),
  p(
    "retired command",
    /\bforge (?:serve|inbox|insights|recommend|sync|team|upgrade|init|orient|prime|status|patch|issues|adapter|dev)\b/i,
  ),
  p("forge release check", /\bforge release check\b/i),
  p("forge skill eval", /\bforge skill (?:eval|scores|coverage)\b/i),
  p("lefthook", /lefthook/i),
  p("husky", /husky/i),
  p("commitlint", /commitlint/i),
  p("stryker", /stryker/i),
  p("graphiti", /graphiti/i),
];

export const RETIRED_PATHS: readonly Pattern[] = [
  p(
    "hook-runner config",
    /(?:^|\/)(?:\.husky|\.lefthook)(?:\/|$)|(?:^|\/)lefthook\.(?:ya?ml|json)$/,
  ),
  p("beads store", /(?:^|\/)\.beads(?:\/|$)/),
  p("commit linter config", /(?:^|\/)(?:commitlint\.config\.|\.commitlintrc)/),
  p("ESLint config", /(?:^|\/)(?:eslint\.config\.|\.eslintrc)/),
  p("mutation tool config", /(?:^|\/)(?:stryker\.conf|\.stryker)/),
  p(
    "generated bookkeeping artifact",
    /(?:^|\/)(?:sync-manifest|test-weights)\.json$/,
  ),
  p("alias or manifest file", /(?:^|\/)_(?:aliases|manifest)\.[cm]?[jt]s$/),
  p("legacy entry point", /(?:^|\/)forge-(?:cmd|preflight)\.[cm]?[jt]s$/),
  p("shell script", /\.(?:sh|bash|zsh)$/),
  p("committed agent mirror", /^\.(?:claude|cursor|codex|hermes)\//),
  p("dropped workspace", /^(?:web|packages|eval)\//),
];

function exempt(path: string): boolean {
  return RETIRED_EXEMPT.some((re) => re.test(path));
}

export function findRetiredNames(
  files: readonly SourceFile[],
  allPaths: readonly string[] = files.map((f) => f.path),
): Violation[] {
  const violations: Violation[] = [];
  for (const path of allPaths) {
    if (exempt(path)) continue;
    for (const pattern of [...RETIRED_PATHS, ...RETIRED_CONTENT]) {
      if (pattern.regex.test(path)) {
        violations.push({
          rule: "retired-names",
          file: path,
          message: `path matches retired "${pattern.name}"; retirement is total, remove it`,
        });
      }
    }
  }
  for (const file of files) {
    if (exempt(file.path)) continue;
    for (const [index, line] of file.text.split(/\r?\n/).entries()) {
      for (const pattern of RETIRED_CONTENT) {
        if (pattern.regex.test(line)) {
          violations.push({
            rule: "retired-names",
            file: file.path,
            line: index + 1,
            message: `names retired "${pattern.name}"; retirement is total, remove it`,
          });
        }
      }
    }
  }
  return violations;
}
