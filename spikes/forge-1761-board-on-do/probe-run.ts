import { start } from './runtime'
for (const [name, paths, flags] of [
  ['unflagged', ['/default', '/node', '/default?memory', '/node?memory'], []],
  ['node-compat', ['/default', '/node', '/default?memory', '/node?memory'], ['--compatibility-flags', 'nodejs_compat']],
] as const) {
  try {
    const server = await start('probe.json', 18761, 'logs/probe-' + name + '.log', [...flags])
    try {
      for (const path of paths) {
        const result = await fetch(server.base + path)
        console.log(name, path, result.status, (await result.text()).slice(0, 2500))
      }
    } finally { await server.stop() }
  } catch (error) { console.log(String(error)) }
}


