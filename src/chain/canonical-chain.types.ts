import type { Hash } from 'viem';

export interface CanonicalBlock {
  number: bigint;
  hash: Hash;
  parentHash: Hash;
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
  depth: number | null;
  orphanedEvents: number;
  replayedEvents: number;
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
