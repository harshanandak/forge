#!/usr/bin/env bun
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

function nowMs() { return performance.now(); }
function timed(fn) { const start = nowMs(); const value = fn(); return { ms: +(nowMs() - start).toFixed(1), value }; }
function run(cmd, args, opts = {}) {
  const start = nowMs();
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { cmd: [cmd, ...args].join(' '), code: r.status, ms: +(nowMs() - start).toFixed(1), stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}
function must(cmd, args, opts = {}) {
  const r = run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${r.cmd}\n${r.stderr || r.stdout}`);
  return r;
}

const mode = process.argv[2];
if (mode === 'sqlite-worker') {
  const dbPath = process.argv[3];
  const worker = process.argv[4];
  const n = Number(process.argv[5] || 50);
  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const insert = db.prepare('INSERT INTO kernel_events(id, entity_type, entity_id, event_type, idempotency_key, expected_revision, actor, origin, payload_json, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
  for (let i = 0; i < n; i++) {
    db.transaction(() => {
      insert.run(`w${worker}-e${i}`, 'issue', `w${worker}-i${i}`, 'issue.create', `w${worker}-k${i}`, 0, `worker-${worker}`, 'spike', '{}', new Date().toISOString());
    })();
  }
  db.close();
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-storage-spike-'));
const results = { tmp, versions: {}, sqlite: {}, dolt: {}, verdictInputs: [] };
results.versions.bun = execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim();
try { results.versions.dolt = execFileSync('dolt', ['version'], { encoding: 'utf8' }).trim().split('\n')[0]; } catch (_e) { results.versions.dolt = 'missing'; }

function sqliteSchema(db) {
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE kernel_issues(id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, entity_revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE TABLE kernel_events(id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, event_type TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, expected_revision INTEGER NOT NULL, actor TEXT NOT NULL, origin TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE kernel_outbox(id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES kernel_events(id), target TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE kernel_claims(id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES kernel_issues(id), actor TEXT NOT NULL, state TEXT NOT NULL, claimed_at TEXT NOT NULL);
CREATE INDEX idx_events_entity_created ON kernel_events(entity_type, entity_id, created_at);
CREATE INDEX idx_outbox_target_status ON kernel_outbox(target, status);`);
}

const sqlitePath = path.join(tmp, 'kernel.sqlite');
const db = new Database(sqlitePath, { create: true });
sqliteSchema(db);
const insertOp = db.prepare(`INSERT INTO kernel_issues(id,title,status,entity_revision,updated_at) VALUES(?,?,?,?,?)`);
const insertEvent = db.prepare(`INSERT INTO kernel_events(id,entity_type,entity_id,event_type,idempotency_key,expected_revision,actor,origin,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`);
const insertOutbox = db.prepare(`INSERT INTO kernel_outbox(id,event_id,target,status,created_at) VALUES(?,?,?,?,?)`);
const createIssue = db.transaction((i) => {
  const t = new Date().toISOString();
  insertOp.run(`s-i${i}`, `Issue ${i}`, 'open', 1, t);
  insertEvent.run(`s-e${i}`, 'issue', `s-i${i}`, 'issue.create', `s-k${i}`, 0, 'agent', 'spike', '{"status":"open"}', t);
  insertOutbox.run(`s-o${i}`, `s-e${i}`, 'beads', 'pending', t);
});
results.sqlite.singleProcess200Ops = timed(() => { for (let i=0;i<200;i++) createIssue(i); }).ms;
results.sqlite.idempotencyDuplicateRejected = (() => { try { createIssue(0); return false; } catch (e) { return /UNIQUE/.test(String(e)); } })();
db.close();
const workers = [];
const conc = timed(() => {
  for (let w=0; w<4; w++) workers.push(spawnSync('bun', [fileURLToPath(import.meta.url), 'sqlite-worker', sqlitePath, String(w), '50'], { encoding: 'utf8' }));
});
results.sqlite.concurrent4x50EventsMs = conc.ms;
results.sqlite.concurrentErrors = workers.filter(w => w.status !== 0).map(w => (w.stderr || w.stdout || '').slice(0, 400));
const checkDb = new Database(sqlitePath);
results.sqlite.eventCount = checkDb.query('SELECT count(*) AS c FROM kernel_events').get().c;
checkDb.close();

const doltDir = path.join(tmp, 'dolt');
fs.mkdirSync(doltDir);
results.dolt.init = must('dolt', ['init', '--name', 'forge-spike', '--email', 'forge-spike@example.com'], { cwd: doltDir }).ms;
const doltSchema = `CREATE TABLE kernel_issues(id varchar(64) PRIMARY KEY, title text NOT NULL, status varchar(32) NOT NULL, entity_revision int NOT NULL, updated_at varchar(64) NOT NULL);
CREATE TABLE kernel_events(id varchar(64) PRIMARY KEY, entity_type varchar(32) NOT NULL, entity_id varchar(64) NOT NULL, event_type varchar(64) NOT NULL, idempotency_key varchar(128) NOT NULL UNIQUE, expected_revision int NOT NULL, actor varchar(64) NOT NULL, origin varchar(64) NOT NULL, payload_json json NOT NULL, created_at varchar(64) NOT NULL);
CREATE TABLE kernel_outbox(id varchar(64) PRIMARY KEY, event_id varchar(64) NOT NULL, target varchar(32) NOT NULL, status varchar(32) NOT NULL, created_at varchar(64) NOT NULL);
CREATE TABLE kernel_claims(id varchar(64) PRIMARY KEY, issue_id varchar(64) NOT NULL, actor varchar(64) NOT NULL, state varchar(32) NOT NULL, claimed_at varchar(64) NOT NULL);`;
results.dolt.createSchema = run('dolt', ['sql', '-q', doltSchema], { cwd: doltDir }).ms;
let sql = 'START TRANSACTION;\n';
for (let i=0;i<200;i++) {
  const t = '2026-06-06T00:00:00Z';
  sql += `INSERT INTO kernel_issues VALUES('d-i${i}','Issue ${i}','open',1,'${t}');\n`;
  sql += `INSERT INTO kernel_events VALUES('d-e${i}','issue','d-i${i}','issue.create','d-k${i}',0,'agent','spike','{}','${t}');\n`;
  sql += `INSERT INTO kernel_outbox VALUES('d-o${i}','d-e${i}','beads','pending','${t}');\n`;
}
sql += 'COMMIT;\n';
results.dolt.singleProcess200Ops = run('dolt', ['sql'], { cwd: doltDir, input: sql }).ms;
const dup = run('dolt', ['sql', '-q', "INSERT INTO kernel_events VALUES('d-e0b','issue','d-i0','issue.create','d-k0',0,'agent','spike','{}','2026-06-06T00:00:00Z');"], { cwd: doltDir });
results.dolt.idempotencyDuplicateRejected = dup.code !== 0 && /duplicate|unique/i.test(dup.stderr + dup.stdout);
results.dolt.commit200Ops = must('dolt', ['commit', '-Am', '200 forge-like ops'], { cwd: doltDir }).ms;
results.dolt.logRows = run('dolt', ['sql', '-r', 'csv', '-q', 'select count(*) as c from dolt_log'], { cwd: doltDir }).stdout;
results.dolt.historyQuery = run('dolt', ['sql', '-r', 'csv', '-q', 'select count(*) as c from dolt_history_kernel_issues'], { cwd: doltDir }).stdout;

must('dolt', ['sql', '-q', "INSERT INTO kernel_claims VALUES('claim-1','d-i1','none','active','2026-06-06T00:00:00Z');"], { cwd: doltDir });
must('dolt', ['commit', '-Am', 'base claim'], { cwd: doltDir });
must('dolt', ['checkout', '-b', 'agent-b'], { cwd: doltDir });
must('dolt', ['sql', '-q', "UPDATE kernel_claims SET actor='agent-b' WHERE id='claim-1';"], { cwd: doltDir });
must('dolt', ['commit', '-Am', 'agent b claim'], { cwd: doltDir });
must('dolt', ['checkout', 'main'], { cwd: doltDir });
must('dolt', ['sql', '-q', "UPDATE kernel_claims SET actor='agent-a' WHERE id='claim-1';"], { cwd: doltDir });
must('dolt', ['commit', '-Am', 'agent a claim'], { cwd: doltDir });
const merge = run('dolt', ['merge', 'agent-b'], { cwd: doltDir });
results.dolt.claimConflictMergeCode = merge.code;
results.dolt.claimConflictMergeOutput = (merge.stdout + '\n' + merge.stderr).split('\n').filter(Boolean).slice(0, 8).join(' | ');
results.dolt.conflictTables = run('dolt', ['sql', '-r', 'csv', '-q', 'select * from dolt_conflicts'], { cwd: doltDir }).stdout;
results.dolt.claimConflictRows = run('dolt', ['sql', '-r', 'csv', '-q', 'select base_actor,our_actor,their_actor from dolt_conflicts_kernel_claims'], { cwd: doltDir }).stdout;

console.log(JSON.stringify(results, null, 2));
