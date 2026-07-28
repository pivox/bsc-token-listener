import type { SwapEvent, TokenSession } from '../types/domain.js';

export function recordEntryObservationBuy(
  session: TokenSession,
  event: SwapEvent,
): { added: boolean; count: number } {
  if (event.kind !== 'BUY') {
    return {
      added: false,
      count: session.entryObservationBuys?.length ?? 0,
    };
  }

  if (!session.entryObservationBuys) {
    session.entryObservationBuys = [];
  }

  const normalizedHash = event.transactionHash.toLowerCase();
  const alreadyRecorded = session.entryObservationBuys.some(
    (item) => item.transactionHash.toLowerCase() === normalizedHash,
  );
  if (alreadyRecorded) {
    return {
      added: false,
      count: session.entryObservationBuys.length,
    };
  }

  session.entryObservationBuys.push(event);

  if (!session.firstBuy) {
    session.firstBuy = event;
  }

  return {
    added: true,
    count: session.entryObservationBuys.length,
  };
}
