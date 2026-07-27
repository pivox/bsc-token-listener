export const pancakeFactoryAbi = [
  {
    type: 'event',
    name: 'PairCreated',
    anonymous: false,
    inputs: [
      { indexed: true, name: 'token0', type: 'address' },
      { indexed: true, name: 'token1', type: 'address' },
      { indexed: false, name: 'pair', type: 'address' },
      { indexed: false, name: 'allPairsLength', type: 'uint256' },
    ],
  },
] as const;
