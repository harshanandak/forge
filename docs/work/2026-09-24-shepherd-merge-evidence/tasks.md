# Task: fix classification and explain every direct-comment blocker

1. Trace actual workflow message producers, adapter identities, all classifier
   callers, verdict ranking and JSON/text rendering before editing.
2. Reproduce the PR #574 success comments becoming blockers and an actual direct
   comment losing its ID/reason. Use the real adapter-to-verdict path where
   practical; do not test only invented terminal envelopes.
3. Implement the smallest shared correction. Match only known success formats
   and expected bot authors. Normalize identity once where existing contracts
   belong, preserving compatibility with current callers.
4. Prove unknown bots, unrecognized Actions comments, package-size failures,
   success near-matches with extra actionable text or a changed threshold,
   unresolved threads, changes requested and mixed blockers remain blocking.
   Preserve human direct-comment behavior: human-shaped success prose cannot
   gain bot status or hide an actual blocker; humans still block through
   unresolved threads and review decisions.
   Cover actual login/line-ending formats, stale comments, and legacy ID fields.
   Missing identity must not produce an unexplained empty blocker result.
5. Verify direct comments expose observed IDs/links and accurate action guidance;
   do not tell users to resolve them as review threads. Keep required-check,
   freshness and settle behavior unchanged, with no extra provider requests.
6. Run focused RED/GREEN tests and strict lint; obtain independent spec then
   quality review. Update the existing Shepherd documentation and changelog.

After implementation review, commit and run canonical validation with the
supported budget. Push unchanged using the personal account, then check
current-head reviews and CI. A live pull on the new PR must recognize its real
informational comments.
