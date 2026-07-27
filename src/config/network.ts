import { getAddress, type Address, type Chain } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';
import type { NetworkName } from './env.js';

export interface PancakeV2Contracts {
  factory: Address;
  router: Address;
}

const contractsByNetwork: Record<NetworkName, PancakeV2Contracts> = {
  mainnet: {
    factory: getAddress('0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73'),
    router: getAddress('0x10ED43C718714eb63d5aA57B78B54704E256024E'),
  },
  testnet: {
    factory: getAddress('0x6725F303b657a9451d8BA641348b6761A6CC7a17'),
    router: getAddress('0xD99D1c33F9fC3444f8101754aBC46c52416550D1'),
  },
};

export function getChain(network: NetworkName): Chain {
  return network === 'mainnet' ? bsc : bscTestnet;
}

export function getPancakeV2Contracts(network: NetworkName): PancakeV2Contracts {
  return contractsByNetwork[network];
}
