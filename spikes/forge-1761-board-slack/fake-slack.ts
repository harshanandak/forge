import { botUser, dmId, linkedUser, slackOrigin } from './trial-constants'

type Fields = Record<string, unknown>
export type SlackCall = { method: string; verb: string; path: string; fields: Fields; authorized: boolean }

export function fakeSlack(token: string) {
  const calls: SlackCall[] = []
  const messages = new Map<string, Fields>()
  const faults: string[] = []
  let sequence = 0
  const makeTs = () => Math.floor(Date.now() / 1000) + '.' + String(++sequence).padStart(6, '0')
  const server = Bun.serve({
    hostname: '127.0.0.1', port: Number(new URL(slackOrigin).port),
    async fetch(request) {
      const url = new URL(request.url)
      const body = await request.text()
      const incoming: Fields = request.headers.get('content-type')?.includes('application/json')
        ? JSON.parse(body)
        : Object.fromEntries(new URLSearchParams([...url.searchParams, ...new URLSearchParams(body)]))
      const fields = { ...incoming }
      if ('token' in fields) fields.token = '[redacted fake token]'
      const method = url.pathname.slice('/api/'.length)
      const authorized = (request.headers.get('authorization') === 'Bearer ' + token || incoming.token === token)
      calls.push({ method, verb: request.method, path: url.pathname, fields, authorized })
      const reply = (fields: Fields) => Response.json(fields, {
        headers: { 'x-oauth-scopes': 'chat:write,chat:write.customize,users:read,im:write,channels:history' },
      })
      if (!authorized || !url.pathname.startsWith('/api/')) {
        faults.push(method + ' was unauthorized or outside /api/')
        return reply({ ok: false, error: 'invalid_auth' })
      }
      const channel = String(fields.channel)
      switch (method) {
        case 'auth.test':
          return reply({ ok: true, user: 'trialbot', user_id: botUser, bot_id: 'BBOT01', team_id: 'TTRIAL01', team: 'Local' })
        case 'users.info': {
          const linked = fields.user === linkedUser
          const name = linked ? 'linked-owner' : 'unlinked-person'
          return reply({ ok: true, user: {
            id: fields.user, name, real_name: linked ? 'Linked Owner' : 'Unlinked Person',
            is_bot: false, profile: { display_name: name, real_name: linked ? 'Linked Owner' : 'Unlinked Person' },
          } })
        }
        case 'conversations.open':
          return reply({ ok: true, channel: { id: dmId, is_im: true, user: fields.users } })
        case 'conversations.info':
          return reply({ ok: true, channel: { id: channel, name: 'fake', is_member: true, is_im: channel === dmId } })
        case 'chat.postMessage': {
          const ts = makeTs()
          const message = { ...fields, text: fields.markdown_text ?? fields.text, ts, type: 'message', user: botUser }
          messages.set(channel + ':' + ts, message)
          return reply({ ok: true, ts, channel, message })
        }
        case 'chat.update': {
          const ts = String(fields.ts)
          const key = channel + ':' + ts
          const previous = messages.get(key)
          if (!previous) return reply({ ok: false, error: 'message_not_found' })
          const message = { ...previous, ...fields, text: fields.markdown_text ?? fields.text }
          messages.set(key, message)
          return reply({ ok: true, ts, channel, message, text: message.text })
        }
        case 'chat.getPermalink':
          return reply({ ok: true, permalink: 'https://trial.invalid/archives/' + channel + '/p' + String(fields.message_ts).replace('.', '') })
        case 'conversations.history':
        case 'conversations.replies': {
          const ts = String(fields.ts ?? fields.latest ?? fields.oldest)
          const message = messages.get(channel + ':' + ts)
          return reply({ ok: true, messages: message ? [message] : [], has_more: false })
        }
        default:
          faults.push('Unexpected Slack method ' + method)
          return reply({ ok: false, error: 'unknown_method' })
      }
    },
  })
  return { server, calls, faults, messages }
}

