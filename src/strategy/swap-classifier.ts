import { isAddressEqual, type Address, type Hash } from 'viem';
import type { ClassifiedSwap, PairInfo, SwapKind } from '../types/domain.js';

export interface RawSwapEvent {
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
  observedAtMs?: number;
}

export function classifySwap(pair: PairInfo, raw: RawSwapEvent): ClassifiedSwap {
  const wbnbIsToken0 = isAddressEqual(pair.token0, pair.wbnb);
  const wbnbIsToken1 = isAddressEqual(pair.token1, pair.wbnb);

  if (wbnbIsToken0 === wbnbIsToken1) {
    throw new Error(`La paire ${pair.pair} ne contient pas exactement un WBNB.`);
  }

  let kind: SwapKind = 'OTHER';
  let amountWbnb = 0n;
  let amountToken = 0n;

  if (wbnbIsToken0) {
    const isBuy = raw.amount0In > 0n && raw.amount1Out > 0n;
    const isSell = raw.amount1In > 0n && raw.amount0Out > 0n;
    if (isBuy && !isSell) {
      kind = 'BUY';
      amountWbnb = raw.amount0In;
      amountToken = raw.amount1Out;
    } else if (isSell && !isBuy) {
      kind = 'SELL';
      amountWbnb = raw.amount0Out;
      amountToken = raw.amount1In;
    }
  } else {
    const isBuy = raw.amount1In > 0n && raw.amount0Out > 0n;
    const isSell = raw.amount0In > 0n && raw.amount1Out > 0n;
    if (isBuy && !isSell) {
      kind = 'BUY';
      amountWbnb = raw.amount1In;
      amountToken = raw.amount0Out;
    } else if (isSell && !isBuy) {
      kind = 'SELL';
      amountWbnb = raw.amount1Out;
      amountToken = raw.amount0In;
    }
  }

  return {
    id: `${raw.transactionHash.toLowerCase()}:${raw.logIndex}`,
    pair: pair.pair,
    transactionHash: raw.transactionHash,
    cursor: {
      blockNumber: raw.blockNumber,
      transactionIndex: raw.transactionIndex,
      logIndex: raw.logIndex,
    },
    sender: raw.sender,
    recipient: raw.recipient,
    kind,
    amountWbnb,
    amountToken,
    amount0In: raw.amount0In,
    amount1In: raw.amount1In,
    amount0Out: raw.amount0Out,
    amount1Out: raw.amount1Out,
    observedAtMs: raw.observedAtMs ?? Date.now(),
  };
}
