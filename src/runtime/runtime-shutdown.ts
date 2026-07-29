interface RuntimeShutdownDrainOptions {
  disableSchedulingAndStopNewWork: () => void;
  stopRecovery: () => Promise<void>;
  waitForMonitorIdle: () => Promise<void>;
  waitForCanonicalIdle: () => Promise<void>;
}

export async function drainRuntimeForShutdown(
  options: RuntimeShutdownDrainOptions,
): Promise<void> {
  options.disableSchedulingAndStopNewWork();
  await options.stopRecovery();
  await options.waitForMonitorIdle();
  await options.waitForCanonicalIdle();
  await options.waitForMonitorIdle();
}
