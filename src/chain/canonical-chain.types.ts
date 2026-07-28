import type { Hash } from 'viem';

export interface CanonicalBlock {
  readonly number: bigint;
  readonly hash: Hash;
  readonly parentHash: Hash;
}

export interface CanonicalBlockReader {
  getBlockNumber(): Promise<bigint>;
  getBlock(blockNumber: bigint): Promise<CanonicalBlock>;
}

export interface ConfirmedRangeRequest {
  listenerKey: string;
  startBlock: bigint;
  processChunk(fromBlock: bigint, toBlock: bigint): Promise<boolean>;
}

export interface AnchoredListenerCheckpoint {
  blockNumber: bigint;
  blockHash: Hash;
}

export interface LegacyListenerCheckpoint {
  blockNumber: bigint;
  blockHash: null;
}

export type ListenerCheckpoint =
  | AnchoredListenerCheckpoint
  | LegacyListenerCheckpoint;

export type CanonicalChainState =
  | 'HEALTHY'
  | 'RECONCILING'
  | 'MANUAL_REVIEW';

export type ChainReorgStatus =
  | 'RECONCILING'
  | 'RECOVERED'
  | 'MANUAL_REVIEW';

export interface ReorgImpact {
  readonly depth: number | null;
  readonly orphanedEvents: number;
  readonly replayedEvents: number;
}

export interface ReorgReconciliation {
  readonly ancestor: CanonicalBlock | null;
  readonly oldTip: CanonicalBlock;
  readonly newTip: CanonicalBlock;
  readonly depth: number | null;
}

export interface CanonicalReorgHandler {
  reconcileReorg(reorg: ReorgReconciliation): Promise<ReorgImpact>;
}

export interface CanonicalReorgSummary extends ReorgReconciliation {
  readonly impact: ReorgImpact;
}

export interface ChainBlockReference {
  number: bigint;
  hash: Hash;
}

export interface ChainReorgAudit {
  id: string;
  detectedAtMs: number;
  commonAncestor: ChainBlockReference | null;
  previousTip: ChainBlockReference;
  replacementTip: ChainBlockReference;
  status: ChainReorgStatus;
  impact: ReorgImpact;
  details: Record<string, unknown>;
}
