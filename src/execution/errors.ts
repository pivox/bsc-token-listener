import type { Hash } from 'viem';

export type BroadcastOutcome = 'UNKNOWN' | 'REVERTED' | 'CONFIRMED_UNPARSED';

export class BroadcastedTransactionError extends Error {
  public override readonly name = 'BroadcastedTransactionError';

  public constructor(
    message: string,
    public readonly transactionHash: Hash,
    public readonly outcome: BroadcastOutcome,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}
