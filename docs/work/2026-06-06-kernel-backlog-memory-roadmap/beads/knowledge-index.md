## Description
Design the Project Knowledge Layer MVP using a verbatim-first read model inspired by MemPalace.

## Scope
- Index source artifacts without summarizing them away.
- Include plan.md, legacy design.md, tasks.md, decisions.md, evidence.md, issue bodies, comments, stage runs, validation logs.
- Store metadata for issue, release, sprint, stage, actor/session, source path, and event id.
- Start with FTS5/read model; vectors can be a later backend.

## Acceptance Criteria
- Reference design exists for the index schema and rebuild behavior.
- Summaries/facts are defined as derived proposals with source refs.
- Search can be scoped before global/deep retrieval.
