import type { BlockerCode } from "./contract.ts";
import type { Evidence, Policy, Verdict } from "./verdict.ts";
/** This entry has no runtime imports: the catalog executes captured bytes. */
function compute(e: Evidence, p: Policy, now: number, digest: string): Verdict {
  const result: Verdict = {
    status: "MERGE_READY",
    blockers: [],
    ignored: [],
    evidenceDigest: digest,
  };
  const priorities = [
    "INCOMPLETE",
    "DRAFT",
    "CONFLICTING",
    "CHECKS_FAILED",
    "CHECKS_PENDING",
    "REVIEW_BLOCKED",
    "REVIEW_REQUIRED",
    "BLOCKED",
    "SETTLING",
    "MERGE_READY",
  ];
  const block = (
    status: string,
    code: BlockerCode,
    message: string,
    ref?: Record<string, string>,
  ): void => {
    result.blockers.push({ code, message, ...(ref ? { ref } : {}) });
    if (priorities.indexOf(status) < priorities.indexOf(result.status))
      result.status = status;
  };
  const incomplete = (code: BlockerCode, message: string): void =>
    block("INCOMPLETE", code, message);
  const ignore = (
    category: "checks" | "reviews",
    ref: string,
    reason: string,
  ): void => {
    result.ignored.push({ category, ref, reason });
  };
  const c = e.core;
  if (!c || e.gaps.some((g) => g.area === "core")) {
    incomplete("CORE_UNREADABLE", "Core is unreadable or changed");
    return result;
  }
  if (c.state === "MERGED" || c.state === "CLOSED") {
    result.status = c.state;
    return result;
  }
  for (const gap of e.gaps)
    incomplete("EVIDENCE_GAP", `${gap.area}: ${gap.code}`);
  if (c.host.canBypass !== false)
    incomplete("BYPASS_CAPABLE", "Credential may bypass rules");
  if (c.mergeable === "UNKNOWN")
    incomplete("MERGEABILITY_UNKNOWN", "Mergeability is unknown");
  let latest = Date.parse(c.updatedAt);
  const timestamp = (value: string | null, activity = true): void => {
    if (value === null) return;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms) || ms > now || !Number.isFinite(now))
      incomplete("EVIDENCE_GAP", "Invalid or future timestamp");
    else if (activity) latest = Math.max(latest, ms);
  };
  timestamp(e.observedAt, false);
  timestamp(c.updatedAt);
  for (const check of e.checks) timestamp(check.startedAt);
  for (const r of e.reviews) {
    timestamp(r.createdAt);
    timestamp(r.submittedAt);
    timestamp(r.updatedAt);
  }
  if (c.draft) block("DRAFT", "DRAFT", "Pull request is a draft");
  if (c.mergeable === "CONFLICTING")
    block("CONFLICTING", "CONFLICTING", "Pull request conflicts with its base");
  for (const r of e.requirements) {
    const ref = { requirementKind: r.kind };
    if (r.state === "unknown")
      block("INCOMPLETE", "REQUIREMENT_UNKNOWN", r.reason, ref);
    if (r.state === "unsatisfied")
      block("BLOCKED", "REQUIREMENT_UNSATISFIED", r.reason, ref);
    if (r.state === "pending")
      block("CHECKS_PENDING", "REQUIREMENT_PENDING", r.reason, ref);
  }
  const groups = new Map<string, Evidence["checks"]>();
  for (const check of e.checks) {
    if (check.headSha !== c.headSha) {
      ignore("checks", check.runId ?? check.name, "Different head");
      continue;
    }
    const key = JSON.stringify([check.name, check.appId]);
    const group = groups.get(key) ?? [];
    group.push(check);
    groups.set(key, group);
  }
  const selected: Evidence["checks"] = [];
  for (const group of groups.values()) {
    if (group.some((x) => x.startedAt === null)) {
      incomplete("CHECK_ORDER_AMBIGUOUS", "Check attempt lacks a start time");
      continue;
    }
    const max = group.reduce(
      (max, x) => Math.max(max, Date.parse(x.startedAt!)),
      -Infinity,
    );
    const winners = group.filter((x) => Date.parse(x.startedAt!) === max);
    if (
      new Set(winners.map((x) => JSON.stringify([x.status, x.conclusion])))
        .size > 1
    )
      incomplete("CHECK_ORDER_AMBIGUOUS", "Check outcomes tie");
    selected.push(winners[0]!);
    for (const check of group)
      if (check !== winners[0])
        ignore("checks", check.runId ?? check.name, "Superseded attempt");
  }
  for (const required of e.requiredChecks) {
    if (
      e.requiredChecks.some(
        (x) => x.name === required.name && x.appId !== required.appId,
      )
    )
      incomplete("CHECK_ORDER_AMBIGUOUS", "Required check identities conflict");
    if (
      !selected.some(
        (x) =>
          x.name === required.name &&
          (required.appId === null || x.appId === required.appId),
      )
    )
      block(
        "CHECKS_PENDING",
        "CHECK_PENDING",
        `Missing required check: ${required.name}`,
        { checkName: required.name },
      );
  }
  if (!groups.size && !e.requiredChecks.length && !p.allowNoChecks)
    block("INCOMPLETE", "NO_CHECKS", "No current-head checks observed");
  for (const check of selected) {
    const required = e.requiredChecks.some(
      (x) =>
        x.name === check.name && (x.appId === null || x.appId === check.appId),
    );
    if (!required && p.optionalChecks === "ignore") continue;
    const ref = { checkName: check.name };
    const status = check.status.toUpperCase(),
      conclusion = check.conclusion?.toUpperCase();
    if (
      ["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"].includes(
        status,
      )
    )
      block("CHECKS_PENDING", "CHECK_PENDING", `${check.name} is pending`, ref);
    else if (status !== "COMPLETED" || conclusion === undefined)
      block(
        "INCOMPLETE",
        "CHECK_STATE_UNKNOWN",
        `${check.name} has an unknown state`,
        ref,
      );
    else if (
      [
        "FAILURE",
        "CANCELLED",
        "TIMED_OUT",
        "ACTION_REQUIRED",
        "STARTUP_FAILURE",
        "STALE",
      ].includes(conclusion)
    )
      block("CHECKS_FAILED", "CHECK_FAILED", `${check.name} failed`, ref);
    else if (!["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion))
      block(
        "INCOMPLETE",
        "CHECK_STATE_UNKNOWN",
        `${check.name} has an unknown conclusion`,
        ref,
      );
  }
  if (
    c.host.mergeStateStatus === "BEHIND" &&
    e.requiredChecks.some((x) => x.strict)
  )
    block("CHECKS_PENDING", "CHECK_PENDING", "Strict branch is behind");
  const authors = new Map<string, Evidence["reviews"]>();
  for (const r of e.reviews) {
    if (
      !r.author ||
      r.author.toLowerCase() === "ghost" ||
      ["COMMENTED", "DISMISSED"].includes(r.state)
    ) {
      ignore("reviews", r.id, "Non-decisive review");
      continue;
    }
    const key = r.author.toLowerCase(),
      group = authors.get(key) ?? [];
    group.push(r);
    authors.set(key, group);
  }
  let approvals = 0;
  for (const group of authors.values()) {
    const stamp = (r: Evidence["reviews"][number]): number =>
      Date.parse(r.state === "PENDING" ? r.createdAt : (r.submittedAt ?? ""));
    if (group.some((r) => !Number.isFinite(stamp(r)))) {
      incomplete("REVIEW_ORDER_AMBIGUOUS", "Review time is missing");
      continue;
    }
    const max = group.reduce((max, r) => Math.max(max, stamp(r)), -Infinity),
      winners = group.filter((r) => stamp(r) === max);
    if (
      new Set(winners.filter((r) => r.authorizing === true).map((r) => r.id))
        .size > 1
    )
      incomplete("REVIEW_ORDER_AMBIGUOUS", "Latest reviews tie");
    const r = winners.find((x) => x.authorizing === true) ?? winners[0]!;
    for (const prior of group)
      if (prior !== r) ignore("reviews", prior.id, "Superseded review");
    if (r.authorizing !== true) continue;
    if (["CHANGES_REQUESTED", "PENDING"].includes(r.state))
      block(
        "REVIEW_BLOCKED",
        "REVIEW_BLOCKED",
        `${r.author} has a blocking review`,
        { reviewId: r.id },
      );
    if (r.state === "APPROVED") {
      if (r.commitSha === c.headSha) approvals++;
      else ignore("reviews", r.id, "Approval on a different head");
    }
  }
  if (approvals < p.minApprovals)
    block(
      "REVIEW_REQUIRED",
      "REVIEW_REQUIRED",
      `${approvals} of ${p.minApprovals} approvals`,
    );
  if (!c.host.allowedMergeMethods.includes(p.mergeMethod))
    block("BLOCKED", "MERGE_METHOD_UNAVAILABLE", "Merge method unavailable");
  for (const label of e.labels)
    if (p.blockingLabels.includes(label))
      block("BLOCKED", "BLOCKING_LABEL", `Blocking label: ${label}`, { label });
  if (now - latest < p.settleMs)
    block("SETTLING", "SETTLING", "Evidence has not settled");
  if (result.status === "MERGE_READY" && c.host.mergeStateStatus !== "CLEAN")
    incomplete("HOST_BLOCKED", "Host does not confirm readiness");
  return result;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
module.exports = {
  compute,
  "pr.evaluate"({
    input,
    config,
    services,
  }: {
    input: Evidence;
    config: Policy;
    services: { crypto: { sha256(text: string): string } };
  }): Verdict {
    const { observedAt: _time, ...state } = input;
    return compute(
      input,
      config,
      Date.now(),
      `sha256:${services.crypto.sha256(canonical(state))}`,
    );
  },
};
