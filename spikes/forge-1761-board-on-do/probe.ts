import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { board as nodeBoard } from './node_modules/@vercel/board/dist/index.node.mjs'

export default {
  async fetch(request: Request) {
    const factory = new URL(request.url).pathname === '/node' ? nodeBoard : board
    return factory({ basePath: '/', backend: local({ dir: '/tmp/board-probe', memory: new URL(request.url).searchParams.has('memory') }), authenticate: () => ({ kind: 'person', id: 'test:user:owner', handle: 'owner' }) }).fetch(
      new Request(new URL('/events', request.url)),
    )
  },
}

