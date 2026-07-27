import {
  decodeEventLog,
  isAddressEqual,
  type TransactionReceipt,
} from 'viem';
import { pancakePairAbi } from '../abi/pancake-pair.abi.js';
import type { ClassifiedSwap, PairInfo } from '../types/domain.js';
import { classifySwap } from '../strategy/swap-classifier.js';

export function findPairSwapInReceipt(
  receipt: TransactionReceipt,
  pair: PairInfo,
): ClassifiedSwap | undefined {
  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, pair.pair)) {
      continue;
    }

    try {
      const decoded = decodeEventLog({
        abi: pancakePairAbi,
        eventName: 'Swap',
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      const args = decoded.args;

      return classifySwap(pair, {
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber,
        transactionIndex: Number(log.transactionIndex),
        logIndex: Number(log.logIndex),
        sender: args.sender,
        recipient: args.to,
        amount0In: args.amount0In,
        amount1In: args.amount1In,
        amount0Out: args.amount0Out,
        amount1Out: args.amount1Out,
      });
    } catch {
      // Le reçu peut contenir d'autres logs émis par la paire.
    }
  }

  return undefined;
}
