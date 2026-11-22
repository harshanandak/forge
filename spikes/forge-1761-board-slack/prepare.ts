const dist = 'node_modules/@vercel/board/dist/'
async function patch(source: string, output: string, edits: [RegExp, string][]) {
  let text = await Bun.file(dist + source).text()
  for (const [pattern, replace] of edits) {
    if (!pattern.test(text)) throw new Error(source + ' changed at ' + pattern)
    text = text.replace(pattern, () => replace)
  }
  await Bun.write(dist + output, text)
}

export async function prepare() {
  await patch('local-RoMUU6QX.mjs', 'trial-engine.mjs', [
    [/export \{ local as t \};/, 'export { a2, deliverSchedulerAppend, deliverSchedulerClear, memoryBlob };'],
  ])
  await patch('store-sqlite-D6fIszST.mjs', 'trial-event-store.mjs', [
    [/import \{ DatabaseSync \} from "node:sqlite";\n/, ''],
    [/const db = new DatabaseSync\(path\);\n\s*db\.exec\("pragma busy_timeout = 5000"\);\n\s*setWalJournalMode\(db\);\n\s*db\.exec\("pragma synchronous = normal"\);/, 'const db = options.database;'],
    [/const tx = \(fn\) => \{\n\s*db\.exec\("begin immediate"\);[\s\S]*?\n\t\};/, 'const tx = (fn) => db.transaction(fn);'],
  ])
}
