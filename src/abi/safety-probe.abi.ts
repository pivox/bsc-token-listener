import { parseAbi } from 'viem';

export const safetyProbeAbi = parseAbi([
  'error ProbeResult(uint256 tokensBought, uint256 bnbRecovered)',
  'function probe(address router, address token, uint256 deadline) payable',
]);
