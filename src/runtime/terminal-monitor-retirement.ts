import type { Address } from 'viem';

export interface TerminalMonitorRetirementDependencies {
  stopAndDrain(): Promise<void>;
  deleteCheckpoint(listenerKey: string): Promise<void>;
  releaseCapacity(): void;
}

export async function retireTerminalMonitor(
  pair: Address,
  dependencies: TerminalMonitorRetirementDependencies,
): Promise<void> {
  await dependencies.stopAndDrain();
  await dependencies.deleteCheckpoint(`swap:${pair.toLowerCase()}`);
  dependencies.releaseCapacity();
}
