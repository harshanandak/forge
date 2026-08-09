PRAGMA user_version = 1;
CREATE TABLE kernel_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE kernel_issues (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, entity_revision INTEGER NOT NULL);
CREATE TABLE kernel_comments (id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, body TEXT NOT NULL, actor TEXT NOT NULL);
CREATE TABLE kernel_dependencies (id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, blocks_issue_id TEXT NOT NULL);
CREATE TABLE kernel_claims (id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, actor TEXT NOT NULL, state TEXT NOT NULL);
CREATE TABLE kernel_worktrees (id TEXT PRIMARY KEY, path TEXT NOT NULL, branch TEXT NOT NULL, state TEXT NOT NULL);
CREATE TABLE kernel_stage_runs (id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE kernel_projections (id TEXT PRIMARY KEY, target TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE kernel_events (id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, event_type TEXT NOT NULL);
INSERT INTO kernel_migrations VALUES ('001_initial_kernel_schema', '2026-08-09T00:00:00.000Z');
INSERT INTO kernel_issues VALUES ('synthetic-issue-1', 'Synthetic issue', 'open', 2); -- NOSONAR S1192: repeated synthetic foreign key preserves fixture readability.
INSERT INTO kernel_comments VALUES ('synthetic-comment-1', 'synthetic-issue-1', 'Synthetic comment', 'fixture');
INSERT INTO kernel_dependencies VALUES ('synthetic-dependency-1', 'synthetic-issue-1', 'synthetic-issue-2');
INSERT INTO kernel_claims VALUES ('synthetic-claim-1', 'synthetic-issue-1', 'fixture', 'active');
INSERT INTO kernel_worktrees VALUES ('synthetic-worktree-1', '/synthetic/worktree', 'fixture/branch', 'active');
INSERT INTO kernel_stage_runs VALUES ('synthetic-run-1', 'synthetic-issue-1', 'dev', 'done');
INSERT INTO kernel_projections VALUES ('synthetic-projection-1', 'jsonl', 'issue', 'synthetic-issue-1', 'delivered');
INSERT INTO kernel_events VALUES ('synthetic-event-1', 'issue', 'synthetic-issue-1', 'issue.updated');
