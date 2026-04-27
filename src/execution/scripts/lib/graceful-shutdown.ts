export interface GracefulShutdownOptions {
  drainSeconds?: number    // default 10 — wait window after exit before tearing down
  exitOnComplete?: boolean // default true — process.exit() fallback for SDK timer leaks
  onDrained?: () => void   // called after drain, before handle.stop() — use for post-drain summaries
}

const _started = new WeakSet<object>()

export async function gracefulShutdown(
  handle: { stop(): Promise<void> },
  opts?: GracefulShutdownOptions
): Promise<void> {
  if (_started.has(handle)) return
  _started.add(handle)

  const drainSeconds = opts?.drainSeconds ?? 10
  const exitOnComplete = opts?.exitOnComplete ?? true

  if (drainSeconds > 0) {
    console.log(JSON.stringify({ event: 'driver.draining', drainSeconds }))
    await new Promise<void>(resolve => setTimeout(resolve, drainSeconds * 1000))
  }

  opts?.onDrained?.()

  await handle.stop()

  if (exitOnComplete) {
    process.exit(process.exitCode ?? 0)
  }
}
