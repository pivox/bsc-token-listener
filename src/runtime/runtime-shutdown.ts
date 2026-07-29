interface RuntimeShutdownDrainOptions {
  disableSchedulingAndStopNewWork: () => void;
  stopPositionExits: () => void;
  stopRecovery: () => Promise<void>;
  waitForPositionExitIdle: () => Promise<void>;
  waitForMonitorIdle: () => Promise<void>;
  waitForCanonicalIdle: () => Promise<void>;
}

export async function drainRuntimeForShutdown(
  options: RuntimeShutdownDrainOptions,
): Promise<void> {
  options.disableSchedulingAndStopNewWork();
  options.stopPositionExits();
  await options.stopRecovery();
  await options.waitForPositionExitIdle();
  await options.waitForMonitorIdle();
  await options.waitForCanonicalIdle();
  await options.waitForPositionExitIdle();
  await options.waitForMonitorIdle();
}
