---
name: open-pr
description: "Use when a slice's checks all pass on the final tree and it is ready for review. Pushes, opens the PR from the repo template in the owner's style, links the PR to its issue in Forge, then links and watches it in the harness. Never merges."
---

# open-pr

## Before you open

1. Every check passed on the final tree: `forge check show --input '{"id":"<receipt>"}'` shows your head. No receipt for this head means run `build` Finish again.
2. Size: at most 800 changed lines and 15 files is the target. Above 1500 lines, split before opening.
3. Commits carry no co-author or tool trailers (trailers: none).

## Push and open

1. `git push -u origin <branch>`. Never force-push; that is a one-way door.
2. Write the body to a file with the editor tool, then `gh pr create --base <base> --title "<plain conventional commit>" --body-file <file>`. Long inline shell strings break on quoting.

## The body

Fill the repo's PR template. Style: plain opening; bold takeaways; What review found; Verification.

- **Opening**: the problem as a user sees it, then what this adds. Short sentences, plain words, no internal codes.
- **Before / after**: what a user observes when X happens, before and after. Numbers where real numbers exist, with how they were measured.
- **What review found**: each blocker as a bold user-visible failure and a one-line fix. Empty on the first push.
- **Verification**: the receipt ids from `forge check run`, the test that fails without the change, the CI run for this head.
- **Not verified**: what you did not check. Always present, never empty-by-omission.
- **Models**: who planned, implemented and reviewed. No tool-branding footer.
- `Tracking: <issue id>`.

No machine-local data: no drive paths, usernames or links to files only on your machine.

## Link, twice, never mixed

1. **PR to issue (Forge)**, while you still hold the claim: `forge issue link --input '{"id":"<slice>","relation":"delivers","url":"<pr url>"}'`.
2. **PR to agent thread (harness)**: in T3 Code, `link_pull_request` with the PR URL, then `watch_pull_request`, and end the turn; T3 wakes you on checks, comments or conflicts. Other harnesses: their monitor (Claude Code Monitor or `/loop`), or a background `gh pr checks <n> --watch`. Forge stores neither the thread link nor the watch.

## Then stop

Release the claim if you are a worker: `forge issue release --input '{"id":"<slice>"}'`. Do not merge here; merging is `land`, by the orchestrator. Review feedback is `review`.
