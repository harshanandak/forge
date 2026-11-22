import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync } from 'node:fs'

const offline = {
  SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, Path: process.env.Path,
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false',
  WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: './logs',
  CLOUDFLARE_CF_FETCH_ENABLED: 'false', CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:1/client/v4',
  HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1',
  NO_PROXY: 'localhost,127.0.0.1', WRANGLER_ENABLE_DEV_REGISTRY: 'false',
}

export function processes() {
  const scan = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'workerd.exe' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'wrangler') } | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId,$_.ParentProcessId,$_.Name }"],
  { encoding: 'utf8' })
  if (scan.status !== 0) throw new Error('Process scan failed: ' + scan.stderr)
  return scan.stdout.trim().split(/\r?\n/).filter(Boolean)
}

export async function start(config: string, port: number, log: string, extra: string[] = [], scrub = (value: string) => value) {
  const listener = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } })
  listener.stop(true)
  mkdirSync('logs', { recursive: true })
  const sink = Bun.file(log).writer()
  const child = Bun.spawn(['node', 'node_modules/wrangler/bin/wrangler.js', 'dev', '--local',
    '--config', config, '--env-file', 'empty-wrangler-vars.txt', '--ip', '127.0.0.1', '--port', String(port), '--show-interactive-dev-session=false',
    '--persist-to', './state', ...extra], { env: offline, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  let listening = false
  const drains = [child.stdout, child.stderr].map(async (stream) => {
    const reader = stream.pipeThrough(new TextDecoderStream())
    let buffer = ''
    for await (const data of reader) {
      buffer += data
      const end = buffer.lastIndexOf('\n') + 1
      const lines = buffer.slice(0, end)
      listening ||= lines.includes('Ready on')
      sink.write(scrub(lines))
      buffer = buffer.slice(end)
    }
    sink.write(scrub(buffer))
  })
  const base = 'http://127.0.0.1:' + port
  let closing: Promise<void> | undefined
  const interrupt = () => { void stop().finally(() => process.exit(130)) }
  const stop = () => closing ??= (async () => {
    process.removeListener('SIGINT', interrupt)
    if (child.exitCode === null) {
      const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'])
      if (killed.status !== 0 && child.exitCode === null) child.kill()
    }
    await child.exited
    await Promise.all(drains)
    await sink.end()
  })()
  process.once('SIGINT', interrupt)
  try {
    for (let i = 0; i < 300 && child.exitCode === null; i++) {
      if (listening) return { base, stop, pid: child.pid }
      await Bun.sleep(100)
    }
    throw new Error('Wrangler did not start. See ' + log)
  } catch (error) {
    await stop()
    throw error
  }
}

export function size() {
  const path = readdirSync('.wrangler/tmp', { recursive: true }).map(String)
    .filter((path) => /(?:^|[/\\])dev-[^/\\]+[/\\](?:baseline-)?worker\.js$/.test(path))
    .map((path) => Bun.file('.wrangler/tmp/' + path))
    .sort((a, b) => b.lastModified - a.lastModified)[0]
  if (!path) throw new Error('Wrangler bundle not found')
  return path.arrayBuffer().then((data) => ({ bytes: data.byteLength, gzipBytes: Bun.gzipSync(data).byteLength }))
}


