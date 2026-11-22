import assert from 'node:assert/strict'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { p as sdk } from './node_modules/@vercel/board/dist/errors-DDfXnZ2b.mjs'
import { fakeSlack } from './fake-slack'
import { prepare } from './prepare'
import { processes, size, start } from './runtime'
import { boardOrigin, channelId, dmId, linkedUser, slackOrigin, unlinkedUser } from './trial-constants'

const startedAt = performance.now()
const runId = randomUUID()
const fakeBotToken = 'xoxb-FAKE-LOCAL-ONLY-' + runId
const fakeSigningSecret = 'fake-local-signing-' + randomUUID()
const generated = 'trial-credentials.ts'
const networkFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const request = new Request(input, { ...init, redirect: 'error' })
  assert.ok([boardOrigin, slackOrigin].includes(new URL(request.url).origin), 'Trial blocks outbound HTTP')
  return networkFetch(request)
}

function client(person: 'agent' | 'owner') {
  return sdk({ url: boardOrigin, fetch: (input, init) => {
    const request = new Request(input, init)
    assert.equal(new URL(request.url).origin, boardOrigin)
    const headers = new Headers(request.headers)
    headers.set('authorization', 'Bearer ' + person)
    headers.set('x-trial-board', runId)
    return fetch(new Request(request, { headers, signal: request.signal }))
  } })
}
const agent = client('agent')
const owner = client('owner')
const before = processes()
const slack = fakeSlack(fakeBotToken)
const results = {
  runId, driverPid: process.pid, pids: [] as number[], before, after: [] as string[],
  remaining: [] as string[], portsReleased: [] as number[],
  bundle: {} as Record<string, Awaited<ReturnType<typeof size>>>,
  outcomes: {} as Record<string, unknown>,
  slackCalls: slack.calls, slackFaults: slack.faults,
  samples: [] as ({ iteration: number; ms: number } | { iteration: number; error: string })[],
  elapsedSeconds: 0,
}
type Target = { channel: string; ts: string }
let launcher: Awaited<ReturnType<typeof start>> | undefined
function describe(error: unknown) {
  return String((error as Error)?.stack ?? error)
}
function clean(text: string) {
  return text.replaceAll(fakeBotToken, '[fake token]').replaceAll(fakeSigningSecret, '[fake secret]')
}
async function record(label: string, f: () => Promise<unknown>) {
  try { results.outcomes[label] = await f() }
  catch (error) {
    const failure = clean(describe(error))
    results.outcomes[label] = { error: failure }
    console.error(label, failure)
  }
}
async function until<T>(read: () => T | Promise<T>, isReady: (item: T) => boolean, label: string, ms = 5000): Promise<T> {
  const deadline = performance.now() + ms
  do {
    const item = await read()
    if (isReady(item)) return item
    await Bun.sleep(15)
  } while (performance.now() < deadline)
  throw new Error(label + ' did not happen within ' + ms + 'ms')
}
async function status(channel: string) {
  const response = await fetch(boardOrigin + '/trial-status?' + new URLSearchParams({ channel }), {
    headers: { 'x-trial-board': runId }, signal: AbortSignal.timeout(2500),
  })
  assert.equal(response.status, 200, await response.clone().text())
  return response.json() as Promise<{ waiting: boolean; decisions: { author: string; linkedPrincipal: string | null }[] }>
}
const messageText = (fields: Record<string, unknown>) => fields.markdown_text ?? fields.text
async function post(channel: string, text: string, destination = channelId) {
  const start = slack.calls.length
  const root = await agent.post(channel, text)
  assert.equal(root.by.principal, 'trial:user:agent')
  const sent = (await until(() => slack.calls.slice(start).find((call) =>
    call.method === 'chat.postMessage' && String(messageText(call.fields)).includes(text.split(' @[')[0]!)),
    Boolean, 'Slack post for ' + channel))!
  assert.equal(sent.fields.channel, destination)
  const targetEntry = Array.from(slack.messages.entries()).find(([, value]) => value.text === messageText(sent.fields) && value.channel === destination)
  assert.ok(targetEntry, 'Slack accepted the message')
  const target = { channel: destination, ts: String(targetEntry[1].ts) }
  // Slack accepts the post before Board finishes its own copy receipt and thread association.
  await until(() => agent.sync(root.id), (sync) => sync.targets.some((entry) =>
    entry.thread === 'slack:' + target.channel + ':' + target.ts && entry.message === target.ts),
    'Board records Slack thread for ' + channel)
  return { root, target, sent }
}
let replySequence = 700000
function replyEvent(target: Target, user: string, text: string) {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const ts = timestamp + '.' + String(++replySequence)
  const body = JSON.stringify({
    type: 'event_callback', team_id: 'TTRIAL01', api_app_id: 'ATRIAL01', event_id: 'Ev' + randomUUID(),
    event_time: Number(timestamp),
    event: { type: 'message', user, channel: target.channel, channel_type: target.channel === dmId ? 'im' : 'channel',
      ts, event_ts: ts, thread_ts: target.ts, text },
  })
  const signatures = [fakeSigningSecret, 'fake-wrong-key'].map((secret) =>
    'v0=' + createHmac('sha256', secret).update('v0:' + timestamp + ':' + body).digest('hex'))
  return async (valid = true) => {
    const response = await fetch(boardOrigin + '/webhooks/slack', {
      method: 'POST', body, signal: AbortSignal.timeout(5000),
      headers: { 'x-trial-board': runId, 'content-type': 'application/json',
        'x-slack-request-timestamp': timestamp, 'x-slack-signature': signatures[valid ? 0 : 1]! },
    })
    return { status: response.status, body: await response.text() }
  }
}

async function sample(iteration: number) {
  const cancel = new AbortController()
  let pending: Promise<unknown> | undefined
  try {
    const channel = 'channel/' + iteration
    const { root, target } = await post(channel, 'Question ' + iteration)
    const { events } = await agent.poll({ channel, last: 1 })
    const after = events.at(-1)?.cursor
    assert.ok(after, 'Need existing Board cursor')
    const wait = agent.wait({ channel, re: root.id, after }, { timeout: 6000, signal: cancel.signal })
      .then((event) => ({ event, at: performance.now() }), (error) => ({ error }))
    pending = wait
    await until(() => status(channel), (value) => value.waiting, 'Board wait for ' + channel)
    const text = 'Slack reply ' + iteration
    const send = replyEvent(target, linkedUser, text)
    const sentAt = performance.now()
    const ack = await send()
    assert.equal(ack.status, 200, ack.body)
    const answer = await wait
    if ('error' in answer) throw answer.error
    assert.equal(answer.event?.type, 'message.posted')
    const reply = answer.event?.message
    assert.equal(reply?.text, text)
    assert.equal(reply?.re, root.id)
    const saved = await agent.thread(root.id)
    assert.equal(saved.replies.find((message) => message.id === reply?.id)?.text, text)
    results.samples.push({ iteration, ms: answer.at - sentAt })
    if (iteration === 1) results.outcomes.inboundExample = { ack, root: root.id, reply }
  } catch (error) {
    const failure = clean(describe(error))
    results.samples.push({ iteration, error: failure })
    console.error('Q3 sample', iteration, failure)
  } finally {
    cancel.abort()
    await pending
  }
}

try {
  await Bun.write(generated, 'export const fakeBotToken = ' + JSON.stringify(fakeBotToken) +
    '\nexport const fakeSigningSecret = ' + JSON.stringify(fakeSigningSecret) + '\n')
  const packagedSync = ['sync-slack.mjs', 'engine-C8wCzkw-.mjs', 'chat-provider-Br2RXgLV.mjs']
  const digestSync = async () => Object.fromEntries(await Promise.all(packagedSync.map(async (file) => {
    const bytes = await Bun.file('node_modules/@vercel/board/dist/' + file).bytes()
    return [file, createHash('sha256').update(bytes).digest('hex')]
  })))
  const beforePatches = await digestSync()
  await prepare()
  await record('Q7 packaged Slack sync hashes', async () => {
    assert.deepEqual(await digestSync(), beforePatches)
    return beforePatches
  })
  await record('baseline', async () => {
    const baseline = await start('wrangler-baseline.json', 18761, 'logs/baseline.log')
    results.pids.push(baseline.pid)
    try {
      assert.equal(await (await fetch(boardOrigin + '/health')).text(), 'ready')
      return results.bundle.baseline = await size()
    } finally {
      await baseline.stop()
    }
  })
  await record('Q1 same Worker and Durable Object', async () => {
    launcher = await start('wrangler.json', 18761, 'logs/slack-worker.log', [], clean)
    results.pids.push(launcher.pid)
    assert.equal(await (await fetch(boardOrigin + '/health')).text(), 'ready')
    const channel = 'channel/hosting'
    const { root, target } = await post(channel, 'Hosting smoke')
    return { root: root.id, target }
  })
  await record('Q7 bundle', async () => {
    const integrated = results.bundle.integrated = await size()
    return Object.fromEntries(Object.entries(integrated).map(([key, value]) =>
      [key, value - results.bundle.baseline![key as keyof typeof integrated]]))
  })
  await record('Q2 channel mention', async () => {
    const sample = await post('channel/mention', 'Channel question @[' + 'slack:user:' + linkedUser + ']')
    assert.match(String(messageText(sample.sent.fields)), new RegExp('<@' + linkedUser + '>'))
    return sample.sent
  })
  await record('Q2 existing DM', async () => (await post('direct-existing', 'Existing DM question', dmId)).sent)
  await record('Q2 DM by person', async () => {
    const offset = slack.calls.length
    const sample = await post('direct-person', 'Person DM question', dmId)
    const open = slack.calls.slice(offset).find((call) => call.method === 'conversations.open')
    assert.equal(open?.fields.users, linkedUser)
    return { open, post: sample.sent }
  })
  for (let iteration = 1; iteration <= 20; iteration++) await sample(iteration)
  await record('Q4 linked and unlinked', async () => {
    const verified = await owner.post('trial-identities', 'Verified owner')
    assert.equal(verified.by.principal, 'trial:user:owner')
    const { root, target } = await post('identity', 'Identity question')
    const accepted = await replyEvent(target, linkedUser, 'Linked answer')()
    const refused = await replyEvent(target, unlinkedUser, 'Unlinked answer')()
    assert.equal(accepted.status, 200, accepted.body)
    assert.equal(refused.status, 200, refused.body)
    const seen = await until(() => status('identity'), (value) => value.decisions.length >= 2, 'Both middleware decisions')
    assert.deepEqual(seen.decisions, [
      { author: 'slack:user:' + linkedUser, linkedPrincipal: verified.by.principal },
      { author: 'slack:user:' + unlinkedUser, linkedPrincipal: null },
    ])
    const thread = await agent.thread(root.id)
    assert.deepEqual(thread.replies.map((message) => message.text), ['Linked answer'])
    return { verified: verified.by, accepted, refused, decisions: seen.decisions, replies: thread.replies }
  })
  await record('Q5 edit one Slack message and post separate status', async () => {
    const { root, target } = await post('channel/status', 'Initial status')
    const offset = slack.calls.length
    await agent.edit(root.id, 'Updated status')
    const update = (await until(() => slack.calls.slice(offset).find((call) => call.method === 'chat.update'),
      Boolean, 'Slack update'))!
    assert.equal(update.fields.channel, target.channel)
    assert.equal(update.fields.ts, target.ts)
    assert.match(String(messageText(update.fields)), /Updated status/)
    assert.equal(slack.messages.get(target.channel + ':' + target.ts)?.text, messageText(update.fields))
    assert.equal(slack.calls.slice(offset).filter((call) => call.method === 'chat.postMessage').length, 0)
    await agent.reply(root.id, 'Separate status')
    const separate = (await until(() => slack.calls.slice(offset).find((call) => call.method === 'chat.postMessage'),
      Boolean, 'New Slack status reply'))!
    assert.equal(separate.fields.thread_ts, target.ts)
    assert.match(String(messageText(separate.fields)), /Separate status/)
    return { update, separate }
  })
  await record('Q6 bad signature and replay', async () => {
    const { root, target } = await post('channel/security', 'Signature and replay question')
    const bad = await replyEvent(target, linkedUser, 'Must not appear')(false)
    assert.equal(bad.status, 401, bad.body)
    const duplicate = replyEvent(target, linkedUser, 'Exactly one stored reply')
    const first = await duplicate()
    assert.equal(first.status, 200, first.body)
    await until(() => agent.thread(root.id), (thread) => thread.replies.length === 1, 'Replay case first reply')
    const readInbox = async () => (await agent.inbox('slack', { channel: channelId }))
      .filter(({ event }) => event.thread === 'slack:' + target.channel + ':' + target.ts)
      .map(({ id, event }) => ({ id, text: event.text }))
    const inboxBeforeReplay = await readInbox()
    assert.deepEqual(inboxBeforeReplay.map(({ text }) => text), ['Exactly one stored reply'])
    const second = await duplicate()
    assert.equal(second.status, 200, second.body)
    await Bun.sleep(500)
    const thread = await agent.thread(root.id)
    assert.deepEqual(thread.replies.map((message) => message.text), ['Exactly one stored reply'])
    const inboxAfterReplay = await readInbox()
    assert.deepEqual(inboxAfterReplay, inboxBeforeReplay)
    return { bad, first, second, inboxBeforeReplay, inboxAfterReplay, replies: thread.replies }
  })
  assert.deepEqual(slack.faults, [])
} catch (error) {
  await record('driver', async () => { throw error })
} finally {
  await record('shutdown', async () => {
    try { await launcher?.stop() }
    finally { await slack.server.stop(true) }
    await unlink(generated).catch((error) => { if (error.code !== 'ENOENT') throw error })
    results.after = processes()
    results.remaining = results.after.filter((line) => !before.includes(line))
    assert.deepEqual(results.remaining, [], 'Wrangler and workerd process leftovers')
    for (const origin of [boardOrigin, slackOrigin]) {
      const port = Number(new URL(origin).port)
      const listener = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } })
      listener.stop(true)
      results.portsReleased.push(port)
    }
    return { remaining: results.remaining, portsReleased: results.portsReleased }
  })
  results.elapsedSeconds = (performance.now() - startedAt) / 1000
  await Bun.write('results.json', JSON.stringify(results, null, 2) + '\n')
  const times = results.samples.flatMap((item) => 'ms' in item ? [item.ms] : []).sort((a, b) => a - b)
  const median = times.length === 0 ? null : (times[Math.floor((times.length - 1) / 2)]! + times[Math.floor(times.length / 2)]!) / 2
  const p95 = times[Math.ceil(times.length * 0.95) - 1] ?? null
  const methods = Array.from(new Set(slack.calls.map((call) => call.method)))
  console.log(JSON.stringify({ elapsedSeconds: results.elapsedSeconds, samples: times.length, median, p95,
    bundle: results.bundle, methods, remaining: results.remaining, portsReleased: results.portsReleased }, null, 2))
  if (times.length !== 20 || Object.values(results.outcomes).some((value) => value && typeof value === 'object' && 'error' in value) || slack.faults.length)
    process.exitCode = 1
}


