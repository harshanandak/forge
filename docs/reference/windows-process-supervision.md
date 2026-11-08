# Windows process supervision limits

Every command Forge runs on Windows starts inside its own job object (see
`src/adapters/process/README.md`). Two limits are accepted on purpose.

## The deadline needs a running host

The timeout is a timer in the host process. When the host event loop is blocked, the timer cannot
fire, so the command keeps running until the loop recovers. If the host dies instead, closing the
job handle ends the command and everything it started (kill-on-close).

A job object cannot enforce a wall-clock deadline itself. Its time limits count CPU time, so a
command that sleeps or waits on a network is never stopped by them. A native deadline would need a
helper process or thread, which the direct launcher removed to save startup time.

## Pipe ends are inheritable for a short span

The launcher opens the command's pipe ends non-inheritable and marks them inheritable only just
before `CreateProcessW`, because a handle list accepts only inheritable handles. Another thread
that starts a process without a handle list in those few native calls could inherit them. One
command starts at a time (`MAX_SUPERVISORS` is 1, pinned by
`test/adapters/process/supervisor-limit.test.ts`), and Forge starts no other process in that span.
