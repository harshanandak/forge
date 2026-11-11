export const acceptanceTable = [
  "| Case | Input | Status | Exit | Eligibility | Unchanged |",
  "|---|---|---|---|---|---|",
  "| sample | brief | OK | 0 | lane | existing assertions |",
].join("\n");
export const noTableProblem =
  "brief Acceptance test section requires a table with columns: Case, Input, Status, Exit, Eligibility, Unchanged";
const noRows = "brief acceptance table has no rows";
export const acceptanceCases = [
  ["no table", "Concrete prose only.", noTableProblem],
  [
    "table in another section",
    "Concrete prose only.\n## Goal\n" + acceptanceTable,
    noTableProblem,
  ],
  [
    "missing columns",
    "| Case | Input | Status | Unchanged |\n|---|---|---|---|\n| sample | brief | OK | existing |",
    "brief acceptance table is missing columns: Exit, Eligibility",
  ],
  ["header only", acceptanceTable.split("\n").slice(0, 2).join("\n"), noRows],
  [
    "fenced table",
    "Concrete prose.\n```md\n" + acceptanceTable + "\n```",
    noTableProblem,
  ],
  [
    "commented table",
    "Concrete prose.\n<!--\n" + acceptanceTable + "\n-->",
    noTableProblem,
  ],
  ["empty first cell", acceptanceTable.replace("| sample |", "|   |"), noRows],
] as const;
