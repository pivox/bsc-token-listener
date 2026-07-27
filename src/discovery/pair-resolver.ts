import {
  getAddress,
  isAddressEqual,
  zeroAddress,
  type Address,
  type Hash,
} from 'viem';
import { pancakePairAbi } from '../abi/pancake-pair.abi.js';
import type { PancakeV2Contracts } from '../config/network.js';
import type { AppPublicClient } from '../rpc/clients.js';
import type { PairInfo } from '../types/domain.js';

export interface PairCreatedDetection {
  token0: Address;
  token1: Address;
  pair: Address;
  blockNumber: bigint;
  transactionHash: Hash;
  logIndex: number;
}

export class PairResolver {
  public constructor(
    private readonly publicClient: AppPublicClient,
    private readonly contracts: PancakeV2Contracts,
    private readonly wbnb: Address,
  ) {}

  public async resolve(detection: PairCreatedDetection): Promise<PairInfo | undefined> {
    if (isAddressEqual(detection.pair, zeroAddress)) {
      return undefined;
    }

    const containsWbnb =
      isAddressEqual(detection.token0, this.wbnb) || isAddressEqual(detection.token1, this.wbnb);
    if (!containsWbnb) {
      return undefined;
    }

    const code = await this.publicClient.getCode({ address: detection.pair });
    if (code === undefined || code === '0x') {
      throw new Error(`La paire ${detection.pair} n'a pas de bytecode.`);
    }

    const [actualToken0, actualToken1] = await Promise.all([
      this.publicClient.readContract({
        address: detection.pair,
        abi: pancakePairAbi,
        functionName: 'token0',
      }),
      this.publicClient.readContract({
        address: detection.pair,
        abi: pancakePairAbi,
        functionName: 'token1',
      }),
    ]);

    if (
      !isAddressEqual(actualToken0, detection.token0) ||
      !isAddressEqual(actualToken1, detection.token1)
    ) {
      throw new Error(`Les tokens annoncés par PairCreated ne correspondent pas à la paire ${detection.pair}.`);
    }

    const token = isAddressEqual(actualToken0, this.wbnb) ? actualToken1 : actualToken0;

    return {
      factory: this.contracts.factory,
      router: this.contracts.router,
      pair: getAddress(detection.pair),
      token: getAddress(token),
      token0: getAddress(actualToken0),
      token1: getAddress(actualToken1),
      wbnb: this.wbnb,
      createdBlock: detection.blockNumber,
      createdTransactionHash: detection.transactionHash,
      createdLogIndex: detection.logIndex,
      discoveredAtMs: Date.now(),
    };
  }
}
