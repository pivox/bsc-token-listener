export const ownableAbi = [
  {
    type: 'function',
    stateMutability: 'view',
    name: 'owner',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const;
