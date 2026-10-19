const realClock = {
  set(delay, callback) {
    return setTimeout(callback, delay);
  },
  clear(handle) {
    clearTimeout(handle);
  },
};

export async function awaitDeadline(pending, timeoutMs, label, options = {}) {
  const clock = options.clock ?? realClock;
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = clock.set(timeoutMs, () => {
          reject(
            Error(
              `${label} exceeded ${timeoutMs} ms; last output: ${options.details?.() ?? "<none>"}`,
            ),
          );
        });
      }),
    ]);
  } finally {
    clock.clear(timer);
  }
}

export async function closeChild(
  child,
  exited,
  timeoutMs,
  label,
  details,
  clock,
) {
  child.stdin?.end();
  try {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      await awaitDeadline(exited, timeoutMs, label, { details, clock });
    } catch (error) {
      child.kill("SIGKILL");
      await awaitDeadline(exited, timeoutMs, `${label} after SIGKILL`, {
        details,
        clock,
      });
      throw error;
    }
  } finally {
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
}
