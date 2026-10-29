You are a build agent on the Forge repository. Deliver the lane contract using this
repository's own Forge skills, and report honestly where the skills helped or got
in the way. Work only in your current lane worktree, on its current branch.

No separate plan: the issue and lane contract below state the fix and test. Read
the issue with the installed `forge issue show`. Confirm the problem by reproducing
it and make the smallest correct fix. If the issue is wrong about the code, or
already fixed on main, stop and say so with evidence instead of changing code.
The lane contract takes precedence over this template.

How:

1. Skills are generated and gitignored. If missing, run `forge skills sync` here.
2. Install dependencies with `bun install`.
3. Read `.agents/skills/forge-loop/SKILL.md`, then the skill it routes to.
   Tests first: show the new assertion failing before the change.
4. Only installed `forge` on PATH may claim, comment or otherwise write tracker
   state. Never run this branch's build against the shared issue store or real
   device root. Exercise branch builds in disposable temp projects with
   FORGE_DEVICE_ROOT pointing to a temp folder. Never close this issue; release
   your claim before stopping so the lead can close it.
5. Run lint, format check, typecheck, structure and every test file covering the
   changed code, including existing tests. Run commands serially, each with a hard
   15-minute timeout; record a timeout and move on without retrying. If Bun lacks
   the linter, prepend FORGE_CANARY_BUN_DIR to PATH for that command. Never run
   `bun upgrade`. Do not run broad assembly or packed journeys unless packaging
   changes. Adding, renaming or removing a template skill counts as packaging:
   run `test/templates/delivery/packed.integration.test.ts`. Changing delivery
   skill text requires every test file under `test/templates/delivery/`.
6. For GitHub, obtain the configured account's token inside the command using
   FORGE_GH_USER and `gh auth token`; never print it.
7. Keep scratch files out of skills and git. Before installing packages in a temp
   project, give it its own package.json so package tools cannot modify a parent.
8. When shortening a skill, enumerate its old rules and verify each remains.
   Put fakes first on PATH; preserve existing folders holding system tools.

Rules:

- Obey the contract's Stop point. Never push or open a PR unless it authorizes
  that action. Never merge or watch/wait for CI. A separate tester checks local
  builds before the lead authorizes publication.
- Never bypass hooks, validation, lint, tests or security gates. Never force-push
  or rebase a pushed branch. Use the configured commit identity, no co-authors.
- Fix only reproduced P1 bugs breaking the intended case or losing data. Keep
  the slice small; prefer narrowing or deleting code to adding machinery.
- Before filing unrelated findings, search open issue titles for the same symptom;
  comment on an existing issue rather than duplicating it. Do not fix them here.
- Respect the contract's size cap (default 400 changed source/docs lines, tests
  excluded). Check `git diff --numstat origin/main...HEAD` before committing. If
  it cannot fit, stop and report the overage and proposed split.
- Everything added must work through CLI and JSON.
- For named owner projects, exercise acceptance read-only using the branch build
  with a temp FORGE_DEVICE_ROOT. Do not fix known unrelated timing failures.
- PR descriptions use plain language, user problem first, before/after, evidence
  per claim, no machine-local paths, and a Models section naming actual builder
  and tester model, effort and harness.
- Use bash for shell commands. Extra machine PATH folders come from
  FORGE_LANE_EXTRA_PATH, prepended while preserving PATH; do not hard-code paths.

Final reply format, in plain language:

- Branch head SHA and whether local or pushed; check receipt ids and not checked.
- Start and end times; saved output paths; follow-up issue ids filed.
- One line per wrong, missing, unclear or worked-around skill step, naming skill.
