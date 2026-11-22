import { n as ddl, r as sqlTables } from './node_modules/@vercel/board/dist/sql-D0MqINA6.mjs'
import { t as sqlite } from './node_modules/@vercel/board/dist/trial-event-store.mjs'
import { deliverSchedulerAppend, deliverSchedulerClear } from './node_modules/@vercel/board/dist/trial-engine.mjs'

export function boardStore(storage: DurableObjectStorage) {
  const sql = storage.sql
  const transaction = <T>(fn: () => T) => storage.transactionSync(fn)
  const log = sqlite({ path: ':memory:', database: {
    transaction, close() {},
    exec: (text: string) => sql.exec(text).toArray(),
    prepare: (text: string) => ({
      all: (...values: SqlStorageValue[]) => sql.exec(text, ...values).toArray(),
      get: (...values: SqlStorageValue[]) => sql.exec(text, ...values).toArray()[0],
      run: (...values: SqlStorageValue[]) => {
        const cursor = sql.exec(text, ...values)
        cursor.toArray()
        return { changes: cursor.rowsWritten }
      },
    }),
  } })
  for (const text of ddl()) sql.exec(text)
  const run = (query: { text: string; values: unknown[] }) => sql.exec(
    query.text.replace(/\$(\d+)/g, '?$1'),
    ...query.values.map((value) => typeof value === 'boolean' ? Number(value) : value ?? null) as SqlStorageValue[],
  ).toArray()
  const tables = sqlTables({
    all: async (query: Parameters<typeof run>[0]) => run(query),
    read: async (queries: Parameters<typeof run>[0][]) => transaction(() => queries.map(run)),
    commit: async (claim: Parameters<typeof run>[0], writes: Parameters<typeof run>[0][]) => transaction(() => {
      if (!run(claim).length) return false
      for (const write of writes) run(write)
      return true
    }),
    close: async () => {},
  })
  return { log, tables, close: async () => {} }
}

type Task = { kind: 'drain' | 'append' | 'clear'; dueAt: number; sessionId: string; contract: string; id?: string }
type Server = { contract: { name: string }; drain(sessionId: string): Promise<unknown> }

export function alarmScheduler(storage: DurableObjectStorage) {
  const sql = storage.sql
  sql.exec('CREATE TABLE IF NOT EXISTS trial_tasks (key TEXT PRIMARY KEY, due INTEGER NOT NULL, task TEXT NOT NULL)')
  const first = () => sql.exec<{ key: string; due: number; task: string }>(
    'SELECT key, due, task FROM trial_tasks ORDER BY due, key LIMIT 1',
  ).toArray()[0]
  const arm = () => {
    const next = first()
    return next ? storage.setAlarm(Math.max(Date.now(), next.due)) : storage.deleteAlarm()
  }
  return {
    async schedule(task: Task) {
      const key = task.kind === 'drain' ? JSON.stringify(['drain', task.contract, task.sessionId, task.dueAt]) : task.id!
      sql.exec('INSERT OR IGNORE INTO trial_tasks VALUES (?, ?, ?)', key, task.dueAt, JSON.stringify(task))
      await arm()
    },
    handler(...servers: Server[]) {
      return async () => {
        let next
        while ((next = first()) && next.due <= Date.now()) {
          const task = JSON.parse(next.task) as Task
          const server = servers.find((candidate) => candidate.contract.name === task.contract)
          if (!server) throw new Error('Unknown scheduler contract ' + task.contract)
          if (task.kind === 'drain') await server.drain(task.sessionId)
          else if (task.kind === 'append') await deliverSchedulerAppend(server, task)
          else await deliverSchedulerClear(server, task)
          sql.exec('DELETE FROM trial_tasks WHERE key = ?', next.key)
        }
        await arm()
        return new Response(null, { status: 204 })
      }
    },
  }
}
