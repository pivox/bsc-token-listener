import type { Hash } from 'viem';

export const FRESH_START_REASON = 'FRESH_START_CUTOFF';

export interface FreshStartCutoff {
  readonly number: bigint;
  readonly hash: Hash;
  readonly parentHash: Hash;
}

export interface FreshStartRun {
  readonly id: string;
  readonly cutoff: FreshStartCutoff;
  readonly appliedAtMs: number;
  readonly quarantinedSessions: number;
  readonly quarantinedDecisions: number;
}
