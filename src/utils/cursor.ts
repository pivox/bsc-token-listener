import type { ChainCursor } from '../types/domain.js';

export function compareCursor(left: ChainCursor, right: ChainCursor): number {
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber < right.blockNumber ? -1 : 1;
  }
  if (left.transactionIndex !== right.transactionIndex) {
    return left.transactionIndex < right.transactionIndex ? -1 : 1;
  }
  if (left.logIndex !== right.logIndex) {
    return left.logIndex < right.logIndex ? -1 : 1;
  }
  return 0;
}
