import type { Address, Hash } from 'viem';
import type { PairInfo, SwapEvent } from '../types/domain.js';

export interface RawSwap {
  pair: Address;
  transactionHash: Hash;
  blockNumber: bigint;
  transactionIndex: number;
  logIndex: number;
  sender: Address;
  recipient: Address;
  amount0In: bigint;
  amount1In: bigint;
  amount0Out: bigint;
  amount1Out: bigint;
}

export function classifySwap(pair: PairInfo, raw: RawSwap): SwapEvent {
  const tokenIs0 = pair.token0.toLowerCase() === pair.token.toLowerCase();
  const amountTokenIn = tokenIs0 ? raw.amount0In : raw.amount1In;
  const amountTokenOut = tokenIs0 ? raw.amount0Out : raw.amount1Out;
  const amountWbnbIn = tokenIs0 ? raw.amount1In : raw.amount0In;
  const amountWbnbOut = tokenIs0 ? raw.amount1Out : raw.amount0Out;

  const kind = amountWbnbIn > 0n && amountTokenOut > 0n
    ? 'BUY'
    : amountTokenIn > 0n && amountWbnbOut > 0n
      ? 'SELL'
      : 'OTHER';

  return {
    id: `${raw.transactionHash.toLowerCase()}:${raw.logIndex}`,
    pair: raw.pair,
    transactionHash: raw.transactionHash,
    kind,
    sender: raw.sender,
    recipient: raw.recipient,
    amount0In: raw.amount0In,
    amount1In: raw.amount1In,
    amount0Out: raw.amount0Out,
    amount1Out: raw.amount1Out,
    amountWbnb: kind === 'BUY' ? amountWbnbIn : amountWbnbOut,
    amountToken: kind === 'BUY' ? amountTokenOut : amountTokenIn,
    cursor: {
      blockNumber: raw.blockNumber,
      transactionIndex: raw.transactionIndex,
      logIndex: raw.logIndex,
    },
    observedAtMs: Date.now(),
  };
}
