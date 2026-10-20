const args = process.argv.slice(2),
  scenario = process.env.PR_CASE;
const pr = JSON.parse(
  '{"number":1,"state":"OPEN","isDraft":false,"headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","baseRefName":"main","mergeStateStatus":"CLEAN","reviewDecision":"APPROVED","statusCheckRollup":[]}',
);
for (const name of ["APPDATA", "XDG_CONFIG_HOME", "DBUS_SESSION_BUS_ADDRESS"])
  if (process.env[name] !== `fixture-${name}`) process.exit(3);
const emit = (value) => console.log(JSON.stringify(value));
if (args[0] === "api") {
  emit([
    {
      data: {
        repository: {
          pullRequest: {
            isMergeQueueEnabled: scenario === "queue",
            reviewThreads: { nodes: [{ isResolved: scenario !== "threads" }] },
          },
        },
      },
    },
  ]);
} else if (args[1] === "merge") {
  if (
    !args.includes("--squash") ||
    !args.includes("--match-head-commit") ||
    args.at(-1) !== pr.headRefOid
  )
    process.exit(2);
  if (scenario === "refused") {
    console.error("GitHub branch protection refused");
    process.exit(1);
  }
  console.log("Merged pull request");
} else if (args.at(-1) === "state,mergeCommit") {
  if (scenario === "confirmation") {
    console.error("Confirmation unavailable");
    process.exit(1);
  }
  emit({ state: "MERGED", mergeCommit: { oid: "b".repeat(40) } });
} else {
  if (scenario === "merged" || scenario === "closed")
    pr.state = scenario.toUpperCase();
  if (scenario === "draft") pr.isDraft = true;
  if (scenario === "behind") pr.mergeStateStatus = "BEHIND";
  if (scenario === "changes") pr.reviewDecision = "CHANGES_REQUESTED";
  if (scenario === "failed" || scenario === "pending")
    pr.statusCheckRollup = [
      {
        context: "build",
        state: scenario === "failed" ? "FAILURE" : "PENDING",
      },
    ];
  emit(pr);
}
