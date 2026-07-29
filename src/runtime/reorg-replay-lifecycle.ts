import type { ReorgRollbackImpact } from '../chain/canonical-chain.types.js';
import type { Address } from 'viem';

export interface ShallowReorgReplayDependencies {
  withReplayAdmission<T>(operation: () => Promise<T>): Promise<T>;
  prepareRecoveredSessions(): Promise<void>;
  activateRecoveredSessions(): Promise<
    void | { failedPairs: readonly Address[] }
  >;
  reconcilePairs(): Promise<void>;
  waitForMonitorIdle(): Promise<void>;
  reconcileActiveSwaps(): Promise<void>;
  countCanonicalProcessedEvents(eventIds: readonly string[]): Promise<number>;
  completeReorg(reorgId: string, replayedEvents: number): Promise<void>;
}

export interface PersistedShallowReorgReplayDependencies {
  reconcileProjections(impact: ReorgRollbackImpact): Promise<void>;
  requireManualReview?(reorgId: string): Promise<void>;
  replayAndFinalize(impact: ReorgRollbackImpact): Promise<number>;
}

export async function resumePersistedShallowReorgReplay(
  impact: ReorgRollbackImpact,
  dependencies: PersistedShallowReorgReplayDependencies,
): Promise<number | null> {
  await dependencies.reconcileProjections(impact);
  if (impact.affectedPairs.some((pair) => pair.hasWalletConsequence)) {
    if (!dependencies.requireManualReview) {
      throw new Error(
        'Le rollback hydraté avec conséquence wallet exige une revue manuelle.',
      );
    }
    await dependencies.requireManualReview(impact.reorgId);
    return null;
  }
  return dependencies.replayAndFinalize(impact);
}

/** Completes the audit only after every canonical replay gate has drained. */
export async function finalizeShallowReorgReplay(
  impact: ReorgRollbackImpact,
  dependencies: ShallowReorgReplayDependencies,
): Promise<number> {
  return dependencies.withReplayAdmission(async () => {
    await dependencies.prepareRecoveredSessions();
    await dependencies.reconcilePairs();
    const admission = await dependencies.activateRecoveredSessions();
    if (admission && admission.failedPairs.length > 0) {
      throw new Error(
        `Admission de ${admission.failedPairs.length} listener(s) Swap échouée pendant le replay.`,
      );
    }
    await dependencies.waitForMonitorIdle();
    await dependencies.reconcileActiveSwaps();
    await dependencies.waitForMonitorIdle();
    const replayedEvents = await dependencies.countCanonicalProcessedEvents(
      impact.orphanedEventIds,
    );
    await dependencies.completeReorg(impact.reorgId, replayedEvents);
    return replayedEvents;
  });
}
