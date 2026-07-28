import type { Address, Hash } from 'viem';
import type {
  ReorgRollbackImpact,
  ReorgRollbackPairImpact,
} from './canonical-chain.types.js';
import type {
  ChainCursor,
  SwapEvent,
  TokenSession,
} from '../types/domain.js';

export interface ReorgSessionStore {
  findSession(pair: Address): Promise<TokenSession | null>;
  /**
   * Returns only canonical swap events whose processing completed.
   * Implementations must preserve their audit rows rather than deleting them.
   */
  listCanonicalProcessedEvents(pair: Address): Promise<readonly SwapEvent[]>;
  /**
   * Persists while the runtime recovery barrier owns session mutation.
   */
  saveReconciledSession(
    session: TokenSession,
    canonical: boolean,
  ): Promise<void>;
}

export interface ReorgSessionReconciliationResult {
  readonly monitorsToStop: readonly Address[];
}

function compareCursor(left: ChainCursor, right: ChainCursor): number {
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber < right.blockNumber ? -1 : 1;
  }
  if (left.transactionIndex !== right.transactionIndex) {
    return left.transactionIndex - right.transactionIndex;
  }
  return left.logIndex - right.logIndex;
}

function eventIdentity(event: SwapEvent): string {
  return `${event.transactionHash.toLowerCase()}:${event.cursor.logIndex}`;
}

function restoreCanonicalObservations(
  session: TokenSession,
  canonicalEvents: readonly SwapEvent[],
): void {
  const canonicalIdentities = new Set(canonicalEvents.map(eventIdentity));
  if (
    session.firstBuy
    && !canonicalIdentities.has(eventIdentity(session.firstBuy))
  ) {
    delete session.firstBuy;
  }
  if (session.entryObservationBuys) {
    const observations = session.entryObservationBuys.filter((event) =>
      canonicalIdentities.has(eventIdentity(event))
    );
    if (observations.length === 0) {
      delete session.entryObservationBuys;
    } else {
      session.entryObservationBuys = observations;
    }
  }
}

function rebuildPostEntryBuys(
  session: TokenSession,
  canonicalEvents: readonly SwapEvent[],
): void {
  const entry = session.entry;
  if (!entry) {
    session.countedBuyTransactionHashes = [];
    session.subsequentBuyCount = 0;
    return;
  }
  const entryHash = entry.transactionHash?.toLowerCase();
  const hashes: Hash[] = [];
  const seen = new Set<string>();
  const orderedEvents = [...canonicalEvents].sort((left, right) =>
    compareCursor(left.cursor, right.cursor)
  );
  for (const event of orderedEvents) {
    const hash = event.transactionHash.toLowerCase();
    if (
      event.kind !== 'BUY'
      || compareCursor(event.cursor, entry.cursor) <= 0
      || hash === entryHash
      || seen.has(hash)
    ) {
      continue;
    }
    seen.add(hash);
    hashes.push(hash as Hash);
  }
  session.countedBuyTransactionHashes = hashes;
  session.subsequentBuyCount = hashes.length;
}

function deterministicPairs(
  pairs: readonly ReorgRollbackPairImpact[],
): ReorgRollbackPairImpact[] {
  return [...pairs].sort((left, right) =>
    left.pairAddress.toLowerCase().localeCompare(
      right.pairAddress.toLowerCase(),
    )
  );
}

export class ReorgSessionReconciler {
  constructor(
    private readonly store: ReorgSessionStore,
    private readonly now: () => number = Date.now,
  ) {}

  async reconcile(
    impact: ReorgRollbackImpact,
  ): Promise<ReorgSessionReconciliationResult> {
    const monitorsToStop: Address[] = [];
    for (const affected of deterministicPairs(impact.affectedPairs)) {
      if (
        affected.discoveryOrphaned
        && !affected.hasWalletConsequence
      ) {
        monitorsToStop.push(affected.pairAddress);
      }
      await this.reconcilePair(affected);
    }
    return { monitorsToStop };
  }

  private async reconcilePair(
    affected: ReorgRollbackPairImpact,
  ): Promise<void> {
    const current = await this.store.findSession(affected.pairAddress);
    if (!current) {
      throw new Error(
        `Session affectée par la réorganisation introuvable: ${affected.pairAddress}.`,
      );
    }

    if (affected.hasWalletConsequence) {
      const manualReview = structuredClone(current);
      manualReview.status = 'MANUAL_REVIEW';
      manualReview.rejectionReason =
        'Conséquence wallet conservée après réorganisation de chaîne.';
      manualReview.updatedAtMs = this.now();
      await this.store.saveReconciledSession(manualReview, true);
      return;
    }

    if (affected.discoveryOrphaned) {
      const rejected = structuredClone(current);
      rejected.status = 'REJECTED';
      rejected.rejectionReason =
        'Découverte de paire invalidée par une réorganisation de chaîne.';
      rejected.updatedAtMs = this.now();
      await this.store.saveReconciledSession(rejected, false);
      return;
    }

    const snapshot = affected.earliestSessionBefore
      ?? affected.latestCanonicalSessionAfter;
    if (!snapshot) {
      const manualReview = structuredClone(current);
      manualReview.status = 'MANUAL_REVIEW';
      manualReview.rejectionReason =
        'Projection issue d’un snapshot non reconstructible après réorganisation de chaîne.';
      manualReview.updatedAtMs = this.now();
      await this.store.saveReconciledSession(manualReview, true);
      return;
    }

    const restored = structuredClone(snapshot);
    const canonicalEvents = await this.store.listCanonicalProcessedEvents(
      affected.pairAddress,
    );
    restoreCanonicalObservations(restored, canonicalEvents);
    if (restored.status === 'WAITING_FIRST_BUY') {
      delete restored.firstBuy;
      delete restored.entryObservationBuys;
      delete restored.riskReportId;
    }
    rebuildPostEntryBuys(restored, canonicalEvents);
    restored.updatedAtMs = this.now();
    await this.store.saveReconciledSession(restored, true);
  }
}
