import { bsc, bscTestnet } from 'viem/chains';
import { config } from './env.js';

export const chain = config.network === 'mainnet' ? bsc : bscTestnet;
