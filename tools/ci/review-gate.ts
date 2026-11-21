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
const codexQuota =
  /You have reached your Codex usage limits for code reviews\./;
const bots = [
  ["codex", "chatgpt-codex-connector[bot]", codexQuota],
  ["coderabbit", "coderabbitai[bot]", /\breview rate limit exceeded\b/i],
] as const;
function failure(description: string) {
  return { state: "failure" as const, description };
}

function codexState(body: string) {
  const json = /<!-- codex-review-state:v1 (.*?) -->/s.exec(body)?.[1];
  if (!json || body.match(/<!--\s*codex-review-state:/g)?.length !== 1) return;
  try {
    const { code_review: state } = JSON.parse(json) as {
      code_review: {
        commit_sha: string;
        status: string;
        has_any_findings: boolean;
        has_unresolved_findings: boolean;
      };
    };
    if (typeof state.commit_sha !== "string" || !sha.test(state.commit_sha))
      return;
    if (!["completed", "in_progress"].includes(state.status)) return;
    if (typeof state.has_any_findings !== "boolean") return;
    if (typeof state.has_unresolved_findings !== "boolean") return;
    return state;
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

  let block = -Infinity;
  let checkedThrough = -Infinity;
  let exactPass = -Infinity;
  let fullPass = -Infinity;
  for (const row of rows) {
    if (!Number.isFinite(row.at) || row.at > now)
      return failure("invalid ledger time");
    if (!Number.isInteger(row.p1) || row.p1 < 0)
      return failure("invalid P1 count");
    const exactSol = row.head === head && row.kind === "sol";
    if (row.p1 > 0 || (exactSol && row.verdict !== "PASS"))
      block = Math.max(block, row.at);
    if (row.kind !== "sol" || row.verdict !== "PASS" || row.p1 !== 0) continue;
    checkedThrough = Math.max(checkedThrough, row.at);
    if (!exactSol) continue;
    exactPass = Math.max(exactPass, row.at);
    if (/\bfull\b/.test(row.note)) fullPass = Math.max(fullPass, row.at);
  }
  if (block > -Infinity && exactPass <= block) return failure("Sol blocked");
  const securityPass = guard.securitySolPass === true && exactPass > block;
  if (guard.securityPathNeedsSol !== false && !securityPass)
    return failure("security path needs Sol");

  const routes: string[] = [];
  for (const [bot, login, quota] of bots) {
    const authored = ({ author }: { author: Author }) =>
      author.type === "Bot" && author.login === login;
    const comments = evidence.comments.filter(authored);
    const findings = evidence.findings.filter(authored);
    if (findings.some((finding) => !(finding.at < checkedThrough)))
      return failure(`unchecked ${bot} findings`);

    let completed: boolean;
    if (bot === "codex") {
      const [note, duplicate] = comments.filter((comment) =>
        comment.body.includes("<!-- codex-pull-request-review-summary -->"),
      );
      const summary = note && codexState(note.body);
      if (duplicate || (note && !summary))
        return failure("unknown codex summary");
      if (
        summary?.has_unresolved_findings ||
        (summary?.has_any_findings && !findings.length)
      )
        return failure("incomplete codex findings");
      completed =
        summary?.commit_sha === head && summary.status === "completed";
    } else {
      const exact = evidence.reviews.filter(
        (review) => authored(review) && review.head === head,
      );
      for (const { id, body, state } of exact) {
        const format =
          /^<!-- coderabbit-ai-generated:v1 -->\s+\*\*Actionable comments posted: (\d+)\*\*/;
        const count = Number(format.exec(body)?.[1]);
        const inline = findings.filter((finding) => finding.reviewId === id);
        if (
          !(count <= inline.length) ||
          !["APPROVED", "COMMENTED"].includes(state)
        )
          return failure("incomplete coderabbit review");
      }
      completed = exact.length > 0;
    }
    if (completed) {
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
