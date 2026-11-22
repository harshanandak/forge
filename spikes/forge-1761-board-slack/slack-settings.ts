import { createSlackAdapter } from '@chat-adapter/slack'
import { channels, slack } from '@vercel/board/sync-slack'
import { fakeBotToken, fakeSigningSecret } from './trial-credentials'

import { channelId, dmId, linkedUser, slackOrigin } from './trial-constants'

export function syncSettings() {
  const adapter = createSlackAdapter({
    apiUrl: slackOrigin + '/api/',
    botToken: fakeBotToken,
    signingSecret: fakeSigningSecret,
    webClientOptions: {
      allowAbsoluteUrls: false,
      retryConfig: { retries: 0 },
      timeout: 2000,
      requestInterceptor: (config) => {
        if (new URL(config.url ?? '', config.baseURL).origin !== slackOrigin)
          throw new Error('Trial blocks outbound Slack HTTP')
        return config
      },
    },
  })
  return {
    slack: slack({ adapter }, channels({
      [channelId]: async (event) => {
        if (event.direction === 'in') await event.import()
        else if (event.target !== null) await event.deliver()
        else if (event.message.channel.startsWith('channel/') || event.message.channel === 'identity')
          await event.start(channelId)
        else if (event.message.channel === 'direct-person') {
          const direct = await adapter.openDM(linkedUser)
          await event.start(adapter.decodeThreadId(direct).channel)
        }
      },
      [dmId]: 'direct-existing',
    })),
  }
}

