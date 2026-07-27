export const pancakePairAbi = [
  {
    type: 'event',
    name: 'Swap',
    anonymous: false,
    inputs: [
      { indexed: true, name: 'sender', type: 'address' },
      { indexed: false, name: 'amount0In', type: 'uint256' },
      { indexed: false, name: 'amount1In', type: 'uint256' },
      { indexed: false, name: 'amount0Out', type: 'uint256' },
      { indexed: false, name: 'amount1Out', type: 'uint256' },
      { indexed: true, name: 'to', type: 'address' },
    ],
  },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'getReserves',
    inputs: [],
    outputs: [
      { name: '_reserve0', type: 'uint112' },
      { name: '_reserve1', type: 'uint112' },
      { name: '_blockTimestampLast', type: 'uint32' },
    ],
  },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'token0',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'token1',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'totalSupply',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;
