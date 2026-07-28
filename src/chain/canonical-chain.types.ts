import type { Hash } from 'viem';

export interface CanonicalBlock {
  number: bigint;
  hash: Hash;
  parentHash: Hash;
}

export interface ListenerCheckpoint {
  blockNumber: bigint;
  blockHash: Hash;
}

export type CanonicalChainState =
  | 'HEALTHY'
  | 'RECONCILING'
  | 'MANUAL_REVIEW';

export interface ReorgImpact {
  orphanedBlockCount: number;
  orphanedEventCount: number;
  affectedSessionCount: number;
}

export interface ChainBlockReference {
  number: bigint;
  hash: Hash;
}

export interface ChainReorgAudit {
  id: string;
  detectedAtMs: number;
  commonAncestor: ChainBlockReference;
  previousTip: ChainBlockReference;
  replacementTip: ChainBlockReference;
  state: CanonicalChainState;
  impact: ReorgImpact;
}
