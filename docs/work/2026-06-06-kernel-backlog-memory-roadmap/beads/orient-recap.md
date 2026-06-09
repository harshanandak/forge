## Description
Specify bounded context commands over the Project Knowledge Layer.

## Scope
- `forge orient`: project/release/current-branch briefing.
- `forge recap <issue>`: issue-scoped plan/tasks/decisions/evidence recap.
- `forge knowledge search <query>`: deeper retrieval path.
- JSON output for harnesses and frontend.

## Acceptance Criteria
- Command contracts define token/length budgets.
- Outputs cite source artifacts/events.
- Hermes and other harnesses can consume output without prompt flooding.
