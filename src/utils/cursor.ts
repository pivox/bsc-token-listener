import type { ChainCursor } from '../types/domain.js';

export function compareCursor(left: ChainCursor, right: ChainCursor): number {
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber < right.blockNumber ? -1 : 1;
  }
  if (left.transactionIndex !== right.transactionIndex) {
    return left.transactionIndex - right.transactionIndex;
  }
  return left.logIndex - right.logIndex;
}

export function cursorAfter(left: ChainCursor, right: ChainCursor): boolean {
  return compareCursor(left, right) > 0;
}
