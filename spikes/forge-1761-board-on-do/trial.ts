import assert from 'node:assert/strict'
import { board } from '@vercel/board'
import { conformance } from '@vercel/board/conformance'
import { p as sdk } from './node_modules/@vercel/board/dist/errors-DDfXnZ2b.mjs'
import { o as http } from './node_modules/@vercel/board/dist/server-CdBXNUxf.mjs'
import { prepare } from './prepare'
import { processes, size, start } from './runtime'

const began = Date.now()
const origin = 'http://127.0.0.1:18761'
const runId = crypto.randomUUID()
const before = processes()
const client = (person: 'agent' | 'owner', boardId = runId, extra?: Record<string, string>) => sdk({
  url: origin, fetch: transport(person, boardId, extra),
})
function transport(person: 'agent' | 'owner', boardId: string, extra?: Record<string, string>) {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    assert.equal(new URL(request.url).origin, origin, 'Trial blocks outbound HTTP')
    const headers = new Headers(request.headers)
    for (const [name, value] of Object.entries(extra ?? {})) headers.set(name, value)
    headers.set('authorization', 'Bearer ' + person)
    headers.set('x-trial-board', boardId)
    return fetch(new Request(request, { headers, signal: request.signal, redirect: 'error' }))
  }
}

const agent = client('agent')
const owner = client('owner')
type Flow = 'live' | 'early' | 'resume' | 'restart'
type Sample = { channel: string; ms: number } | { channel: string; error: string }
const results = {
  versions: { board: '0.54.0', wrangler: '4.152.0', bun: Bun.version, node: 'unknown', workerd: '1.20261019.1' },
  runId, pids: [] as number[], before, after: [] as string[], remaining: [] as string[],
  bundle: null as Awaited<ReturnType<typeof size>> | null, identity: null as unknown,
  smoke: { live: [], early: [], resume: [], restart: [] } as Record<Flow, Sample[]>,
  alarm: null as unknown, conformance: null as Awaited<ReturnType<typeof conformance>> | null,
  errors: [] as string[], elapsedSeconds: 0,
}
let server: Awaited<ReturnType<typeof start>> | undefined
async function boot(label: string) {
  server = await start('wrangler.json', 18761, 'logs/' + label + '.log')
  results.pids.push(server.pid)
  assert.equal(await (await fetch(origin + '/health', { signal: AbortSignal.timeout(2000) })).text(), 'ready')
}
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeout = 3000) {
  const end = Date.now() + timeout
  do {
    const value = await read()
    if (predicate(value)) return value
    await Bun.sleep(15)
  } while (Date.now() < end)
  throw new Error('Condition did not become true within ' + timeout + 'ms')
}
const status = async (channel: string, boardId = runId) => {
  const response = await fetch(origin + '/trial-status?' + new URLSearchParams({ channel }), {
    headers: { 'x-trial-board': boardId }, signal: AbortSignal.timeout(3000),
  })
  assert.equal(response.status, 200, await response.clone().text())
  return response.json() as Promise<{ waiting: boolean; scheduledPosts: number }>
}
async function question(channel: string, asking = agent) {
  const root = await asking.post(channel, 'question ' + channel)
  assert.equal(root.by.principal, 'trial:user:agent')
  const { events } = await asking.poll({ channel, last: 1 })
  assert.equal(events[0]?.message?.id, root.id)
  return { root, query: { channel, re: root.id, after: events[0].cursor } }
}
function waiting(query: { channel: string; re: string; after: string }, signal: AbortSignal, asking = agent) {
  return asking.wait(query, { timeout: 5000, signal }).then(
    (event: Awaited<ReturnType<typeof agent.wait>>) => ({ event, at: Date.now() }),
    (error: unknown) => ({ error }),
  )
}
async function flow(kind: Flow, index: number) {
  const channel = kind + '/' + index
  const cancel = new AbortController()
  try {
    if (!server) await boot(kind + '-' + index + '-recovery')
    const { root, query } = await question(channel)
    const initial = kind === 'early' ? undefined : waiting(query, cancel.signal)
    if (initial) await until(() => status(channel), (value) => value.waiting)
    let resumed = initial
    if (kind === 'resume' || kind === 'restart') {
      if (kind === 'restart') {
        await server!.stop()
        server = undefined
        assert.ok('error' in (await initial!), 'The first wait should disconnect')
        await boot('restart-' + index)
        const thread = await agent.thread(root.id)
        assert.equal(thread.message.text, root.text)
        assert.equal(thread.message.by.principal, 'trial:user:agent')
        resumed = waiting(query, cancel.signal, client('agent'))
        await until(() => status(channel), (value) => value.waiting)
      } else {
        cancel.abort()
        const canceled = await initial!
        assert.ok('error' in canceled && (canceled.error as Error).name === 'AbortError', 'The first wait should abort')
        resumed = undefined
      }
    }
    const text = 'reply ' + channel
    const reply = await owner.reply(root.id, text)
    assert.equal(reply.by.principal, 'trial:user:owner')
    const answer = await (resumed ?? waiting(query, AbortSignal.timeout(5500), client('agent')))
    if ('error' in answer) throw answer.error
    assert.equal(answer.event?.type, 'message.posted')
    assert.equal(answer.event?.message?.id, reply.id)
    assert.equal(answer.event?.message?.text, text)
    assert.equal(answer.event?.message?.re, root.id)
    assert.equal(answer.event?.message?.by.principal, 'trial:user:owner')
    const ms = answer.at - Date.parse(reply.createdAt)
    assert.ok(ms >= 0, 'Negative post-to-wait latency: ' + ms)
    if (kind === 'restart') {
      const saved = await agent.thread(root.id)
      assert.equal(saved.message.id, root.id)
      assert.equal(saved.replies.find((message: { id: string }) => message.id === reply.id)?.text, text)
    }
    results.smoke[kind].push({ channel, ms })
  } catch (error) { results.smoke[kind].push({ channel, error: String(error), stack: String((error as Error)?.stack).split('\n').slice(0, 8).join(' | ') } as Sample) }
  finally { cancel.abort() }
}

async function alarmAcrossRestart() {
  const boardId = runId + '-alarm'
  const channel = 'alarm'
  const { root, query } = await question(channel, client('agent', boardId))
  const text = 'scheduled across restart'
  const when = new Date(Date.now() + 12_000)
  await client('owner', boardId).schedule({ re: root.id }, { text, at: when })
  assert.equal((await status(channel, boardId)).scheduledPosts, 0)
  await server!.stop()
  server = undefined
  await boot('alarm-restart')
  assert.ok(Date.now() < when.getTime(), 'Worker restarted after schedule due time')
  await until(() => status(channel, boardId), (value) => value.scheduledPosts === 1, 20_000)
  const event = await client('agent', boardId).wait(query, { timeout: 5000, signal: AbortSignal.timeout(5500) })
  assert.equal(event?.message?.text, text)
  assert.equal(event?.message?.by.principal, 'trial:user:owner')
  return { passed: true, scheduleDue: when.toISOString(), postedAt: event?.createdAt, message: event?.message?.id }
}

try {
  results.versions.node = Bun.spawnSync(['node', '--version']).stdout.toString().trim()
  await prepare()
  await boot('initial')
  results.bundle = await size()
  const identities = [await agent.me(), await owner.me()]
  assert.deepEqual(identities.map((who) => who.principal), ['trial:user:agent', 'trial:user:owner'])
  const refused = await fetch(origin + '/me', { signal: AbortSignal.timeout(3000) })
  assert.equal(refused.status, 401)
  const spoofed = await client('agent', runId, { 'x-board-handle': 'owner', 'x-board-name': 'Owner' }).me()
  assert.equal(spoofed.principal, 'trial:user:agent')
  assert.equal(spoofed.handle, 'agent')
  results.identity = { principals: identities, noCredentialStatus: refused.status, spoofed }
  for (const [kind, count] of [['live', 50], ['early', 50], ['resume', 50], ['restart', 10]] as const) {
    for (let index = 1; index <= count; index++) await flow(kind, index)
    console.log(kind, results.smoke[kind].filter((sample) => 'ms' in sample).length + '/' + count)
  }
  try { results.alarm = await alarmAcrossRestart() }
  catch (error) { results.alarm = { passed: false, error: String(error) } }
  if (!server) await boot('conformance-recovery')
  const remote = (extra?: Record<string, string>) =>
    board({ backend: http(origin, { fetch: transport('owner', runId + '-suite', extra) }) })
  results.conformance = await conformance(remote(), { withHeaders: remote })
} catch (error) {
  results.errors.push(String(error))
} finally {
  await server?.stop().catch((error: unknown) => results.errors.push(String(error)))
  results.after = processes()
  results.remaining = results.after.filter((entry) => !before.includes(entry))
  results.elapsedSeconds = (Date.now() - began) / 1000
  const summary = Object.fromEntries(Object.entries(results.smoke).map(([kind, batch]) => {
    const ms = batch.flatMap((sample) => 'ms' in sample ? [sample.ms] : []).sort((a,b) => a - b)
    const mid = Math.floor(ms.length / 2)
    return [kind, { attempted: batch.length, passed: ms.length, medianMs: ms.length ? (ms[mid] + ms[Math.ceil(ms.length / 2) - 1]) / 2 : null,
      p95Ms: ms[Math.ceil(ms.length * 0.95) - 1] ?? null }]
  }))
  const counts = Object.fromEntries(['passed', 'failed', 'skipped'].map((key) =>
    [key, results.conformance?.checks.filter((check) => check.status === key).length ?? 0]))
  await Bun.write('results.json', JSON.stringify({ ...results, summary, conformanceCounts: counts }, null, 2) + '\n')
  console.log(JSON.stringify({ summary, conformance: counts, alarm: results.alarm, bundle: results.bundle,
    processCheck: results.remaining, errors: results.errors }, null, 2))
  if (results.errors.length || results.remaining.length || !results.conformance?.ok ||
      !(results.alarm as { passed?: boolean } | null)?.passed ||
      Object.values(summary).some(({ attempted, passed }) => attempted !== passed)) process.exitCode = 1
}

