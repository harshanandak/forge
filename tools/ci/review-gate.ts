type Author = { login: string; type: string };
type Message = { author: Author; body: string };
type Comment = Message & { at: number };
type Finding = { author: Author; at: number; reviewId?: number };
type Review = Message & { head: string; id: number; state: string };
export type Evidence = {
  head: string;
  pushedAt: number;
  now: number;
  comments: Comment[];
  reviews: Review[];
  findings: Finding[];
  threads: boolean[];
  truncated: boolean;
};
export type GateRow = {
  head: string;
  at: number;
  kind: string;
  verdict: string;
  p1: number;
  note: string;
};
export type Guard = {
  securityPathNeedsSol: boolean;
  securitySolPass: boolean;
  mainRed: boolean;
};
const sha = /^[0-9a-f]{40}$/;
const ledgerKinds = ["sol", "lead-check", "sonnet-temp", "review-gate"];
const reservedMarker =
  /<!--\s*(?:codex-pull-request-review-summary|codex-review-state|coderabbit-ai-generated)/g;
const botRecord =
  /<!-- (?:codex-pull-request-review-summary -->\s*<!-- codex-review-state:v1 (?<summary>.*?) -->|(?<rabbit>coderabbit-ai-generated:v1) -->(?:\s+\*\*Actionable comments posted: (?<count>\d+)\*\*)?)/s;
const fullReviewScope = /(?:^|\s)\bscope=full\b(?=\s|$)/;
const codexQuota =
  /You have reached your Codex usage limits for code reviews\./;
const bots = [
  ["codex", "chatgpt-codex-connector[bot]", codexQuota],
  ["coderabbit", "coderabbitai[bot]", /\breview rate limit exceeded\b/i],
] as const;
function failure(description: string) {
  return { state: "failure" as const, description };
}

function codexState(json: string) {
  try {
    const parsed = JSON.parse(json) as Record<string, Record<string, unknown>>;
    const {
      commit_sha: head,
      status,
      has_any_findings: hasFindings,
      has_unresolved_findings: unresolved,
    } = parsed.code_review ?? {};
    if (typeof head !== "string" || !sha.test(head)) return;
    if (status !== "completed" && status !== "in_progress") return;
    if (typeof hasFindings !== "boolean" || typeof unresolved !== "boolean")
      return;
    return { head, completed: status === "completed", hasFindings, unresolved };
  } catch {
    return;
  }
}

export function decide(evidence: Evidence, rows: GateRow[], guard: Guard) {
  const { head, pushedAt, now, threads } = evidence;
  const elapsed = now - pushedAt;
  if (!sha.test(head)) return failure("invalid head");
  if (!Number.isFinite(elapsed) || elapsed < 0) return failure("invalid clock");
  if (evidence.truncated !== false) return failure("truncated threads");
  if (!threads.every((resolved) => resolved === true))
    return failure("open threads");
  if (guard.mainRed !== false) return failure("main CI is red");

  for (const { kind, verdict, head: reviewedHead, at, p1 } of rows) {
    if (typeof reviewedHead !== "string") return failure("invalid ledger row");
    if (!ledgerKinds.includes(kind) || !sha.test(reviewedHead))
      return failure("invalid ledger row");
    if (verdict !== "PASS" && verdict !== "BLOCK")
      return failure("invalid ledger row");
    if (!Number.isFinite(at) || at > now) return failure("invalid ledger row");
    if (!Number.isInteger(p1) || p1 < 0) return failure("invalid ledger row");
  }
  const incompleteRabbit = failure("incomplete coderabbit review");
  const rabbitFindings = evidence.findings.filter(
    ({ author }) => author.type === "Bot" && author.login === bots[1][1],
  );
  let summary: ReturnType<typeof codexState>;
  let rabbitComplete = false;
  for (const message of [...evidence.comments, ...evidence.reviews]) {
    const { author, body } = message;
    if (author.type !== "Bot") continue;
    const markers = body.match(reservedMarker)?.length ?? 0;
    const rabbitReview = "id" in message && author.login === bots[1][1];
    if (!markers && !rabbitReview) continue;
    const record = botRecord.exec(body)?.groups;
    if (rabbitReview || record?.rabbit) {
      if (markers !== 1 || !record?.rabbit) return incompleteRabbit;
      const reports = body.match(/Actionable comments posted/g)?.length;
      if (reports !== (record.count ? 1 : undefined)) return incompleteRabbit;
      if ("id" in message && !record.count) return incompleteRabbit;
      if (!rabbitReview) continue;
      const inline = rabbitFindings.filter(
        ({ reviewId }) => reviewId === message.id,
      );
      if (Number(record.count) > inline.length) return incompleteRabbit;
      if (message.head !== head) continue;
      if (!["APPROVED", "COMMENTED"].includes(message.state))
        return incompleteRabbit;
      rabbitComplete = true;
    } else {
      const state = record?.summary && codexState(record.summary);
      if (markers !== 2 || !state) return failure("unknown codex summary");
      if ("id" in message || author.login !== bots[0][1]) continue;
      if (summary) return failure("unknown codex summary");
      summary = state;
    }
  }

  let block = -Infinity;
  let checkedThrough = -Infinity;
  let exactPass = -Infinity;
  let fullPass = -Infinity;
  for (const row of rows) {
    const exactSol = row.head === head && row.kind === "sol";
    if (row.p1 > 0 || (exactSol && row.verdict !== "PASS"))
      block = Math.max(block, row.at);
    if (row.kind !== "sol" || row.verdict !== "PASS" || row.p1 !== 0) continue;
    checkedThrough = Math.max(checkedThrough, row.at);
    if (!exactSol) continue;
    exactPass = Math.max(exactPass, row.at);
    if (fullReviewScope.test(row.note)) fullPass = Math.max(fullPass, row.at);
  }
  if (block > -Infinity && exactPass <= block) return failure("Sol blocked");
  const securityPass = guard.securitySolPass === true && exactPass > block;
  if (guard.securityPathNeedsSol !== false && !securityPass)
    return failure("security path needs Sol");

  const codexComplete = summary?.head === head && summary.completed;
  const routes: string[] = [];
  for (const [bot, login, quota] of bots) {
    const authored = ({ author }: { author: Author }) =>
      author.type === "Bot" && author.login === login;
    const comments = evidence.comments.filter(authored);
    const findings = evidence.findings.filter(authored);
    if (findings.some((finding) => !(finding.at < checkedThrough)))
      return failure(`unchecked ${bot} findings`);

    const missingFindings = summary?.hasFindings && !findings.length;
    if (bot === "codex" && (summary?.unresolved || missingFindings))
      return failure("incomplete codex findings");
    if (bot === "codex" ? codexComplete : rabbitComplete) {
      routes.push(bot);
      continue;
    }
    const overQuota = comments.some(
      (comment) => comment.at >= pushedAt && quota.test(comment.body),
    );
    if (!overQuota && elapsed < 600_000) return failure(`waiting for ${bot}`);
    const reason = overQuota ? "quota" : "timeout";
    if (fullPass <= block) return failure(`Sol needed: ${bot} ${reason}`);
    routes.push(`sol stand-in: ${bot} ${reason}`);
  }
  return { state: "success" as const, description: routes.join("; ") };
}
