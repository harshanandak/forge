# Decision rounds

Find every open decision whose prerequisites are settled. Ask all of them in this round; defer decisions that depend on an unanswered question or pending fact.

Number each question by its stable id, give a short title and recommendation with the reason, and word the question so "yes" accepts the recommended answer. For example: `D1: Scope: Shall we deliver the command first? Recommended: yes, to prove the smallest useful path.`

A bare "yes" in an attended run accepts all recommendations in the current round. A reply naming ids applies only to those decisions.

Record answers under their existing ids, recompute prerequisites and repeat. If an answer changes, reopen only affected decisions and work; keep their ids.

In an unattended or delegated run, take the recommended answers and continue rounds. List every such answer by id, recommendation and reason in the digest, so the user can override it and rerun only affected parts.
