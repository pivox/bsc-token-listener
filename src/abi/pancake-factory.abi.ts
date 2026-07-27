import { parseAbi } from 'viem';

export const pancakeFactoryAbi = parseAbi([
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength)',
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
]);
