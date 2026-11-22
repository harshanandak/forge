import { AsyncLocalStorage } from 'node:async_hooks'
import { DurableObject } from 'cloudflare:workers'
import { board } from '@vercel/board'
import { a2, memoryBlob } from './node_modules/@vercel/board/dist/trial-engine.mjs'
import { alarmScheduler, boardStore } from './storage'

const origin = 'http://127.0.0.1:18761'
const workerFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  if (new URL(input instanceof Request ? input.url : input).origin !== origin) throw new Error('Trial blocks outbound HTTP')
  return workerFetch(input, { ...init, redirect: 'error' })
}

const current = new AsyncLocalStorage<DurableObjectState>()
Object.defineProperty(globalThis, Symbol.for('@vercel/request-context'), {
  value: { get: () => ({ waitUntil: (task: Promise<unknown>) => current.getStore()?.waitUntil(task) }) },
})

type Env = { BOARDS: DurableObjectNamespace<BoardObject> }
export class BoardObject extends DurableObject<Env> {
  // shortcut: attachment bytes live in memory. A deployment needs persistent blob storage.
  private backend = a2({ store: boardStore(this.ctx.storage), scheduler: alarmScheduler(this.ctx.storage), blob: memoryBlob() })
  private app = board({
    backend: this.backend, basePath: '/', url: origin,
    authenticate: ({ credential }) => credential === 'agent' || credential === 'owner'
      ? { kind: 'person', id: 'trial:user:' + credential, handle: credential }
      : null,
  })
  private waiting = new Set<string>()

  async fetch(request: Request) {
    const { pathname, searchParams } = new URL(request.url)
    const channel = searchParams.get('channel')
    if (pathname === '/trial-status') {
      const sent = this.ctx.storage.sql.exec('SELECT 1 FROM a2_events WHERE event_type = ? AND json_extract(payload, ?) = ?',
        'message.posted', '$.text', 'scheduled across restart').toArray().length
      return Response.json({ waiting: !!channel && this.waiting.has(channel), scheduledPosts: sent })
    }
    const observed = pathname === '/events' && Number(searchParams.get('wait')) > 0 && channel
    if (observed) this.waiting.add(observed)
    try { return await current.run(this.ctx, () => this.app.fetch(request)) }
    finally { if (observed) this.waiting.delete(observed) }
  }

  async alarm() {
    const response = await current.run(this.ctx, () => this.backend.scheduler(new Request('http://alarm.internal')))
    if (!response.ok) throw new Error(await response.text())
  }
}

export default {
  async fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname === '/health') return new Response('ready')
    // Detach the body from the incoming stream before Board routes that ignore it respond.
    if (request.body) request = new Request(request, { body: await request.arrayBuffer(), signal: request.signal })
    return env.BOARDS.getByName(request.headers.get('x-trial-board') ?? 'default').fetch(request)
  },
}

