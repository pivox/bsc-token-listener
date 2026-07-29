import type { PairInfo, TokenSession } from '../types/domain.js';

const ORPHANED_DISCOVERY_REASON =
  'Découverte de paire invalidée par une réorganisation de chaîne.';

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function samePairIdentity(left: PairInfo, right: PairInfo): boolean {
  return (
    sameAddress(left.factory, right.factory)
    && sameAddress(left.router, right.router)
    && sameAddress(left.wbnb, right.wbnb)
    && sameAddress(left.pair, right.pair)
    && sameAddress(left.token, right.token)
    && sameAddress(left.token0, right.token0)
    && sameAddress(left.token1, right.token1)
    && left.createdTransactionHash.toLowerCase()
      === right.createdTransactionHash.toLowerCase()
    && left.createdLogIndex === right.createdLogIndex
  );
}

export function restoreReappearedPairSession(
  existing: TokenSession,
  pair: PairInfo,
  now: number,
): TokenSession | null {
  if (
    existing.status !== 'REJECTED'
    || existing.rejectionReason !== ORPHANED_DISCOVERY_REASON
    || !samePairIdentity(existing.pair, pair)
  ) {
    return null;
  }
  const restored = structuredClone(existing);
  restored.pair = structuredClone(pair);
  restored.status = 'WAITING_FIRST_BUY';
  restored.subsequentBuyCount = 0;
  restored.countedBuyTransactionHashes = [];
  restored.sellAttempts = 0;
  restored.updatedAtMs = now;
  for (const field of [
    'firstBuy',
    'entryObservationBuys',
    'entry',
    'exit',
    'riskReportId',
    'pendingExecutionSourceEventId',
    'unreconciledExecution',
    'rejectionReason',
  ] as const) {
    Reflect.deleteProperty(restored, field);
  }
  return restored;
}
