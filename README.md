# Forge research: the owner layer

Research, trials, mocks and technical plans for the Forge owner layer (plan issue forge-1662): the phone ask loop, the brief and all-projects home, and team asks with Slack.

**Status: parked on 2026-11-22 until the Forge cloud work is done.** The plans and the mock are drafts, to be refined at that stage. Nothing here is a commitment and nothing here is shipped.

This is a separate branch of the Forge repository. It is not part of `main` and is never merged into it: it is working material, kept as it was written, so it uses old names and holds trial code that the product's own checks would reject.

Start with [reports/forge-1662-INDEX.md](reports/forge-1662-INDEX.md). It lists every file, says which are current, and gives the order to resume in.

| Folder | What is in it |
|---|---|
| reports/ | Reports, research, evaluations, mocks (HTML), designs and technical plans |
| spikes/forge-1662-tech-plan/ | Briefs given to the plan writers and the checker |
| spikes/forge-1761-board-on-do/, forge-1761-board-slack/, forge-1761-wait-trial/ | Source, results and logs of three local trials |

How to read it:

- Snapshot of the maintainer's working folder taken on 2026-11-22: 216 files. Paths inside the files point at that machine; its user folder name is replaced by `<user>`.
- Many files are raw output from research agents and were not reviewed line by line. The index marks which ones.
- The trials ran on one laptop only. Nothing was deployed. They import `@vercel/board` (Apache-2.0) from npm; no Board source is copied here.
- Not published: the issue triage files and four reports that list open security faults. Security details stay private until fixed, as [SECURITY.md](https://github.com/harshanandak/forge/blob/main/SECURITY.md) asks. Also left out: downloaded packages, build output and the trials' local database folders.
- Issue ids such as forge-1662 refer to the maintainer's Forge issue store, which is the record of decisions.
