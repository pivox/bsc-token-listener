export const safetyProbeAbi = [
  {
    type: 'function',
    stateMutability: 'payable',
    name: 'probe',
    inputs: [
      { name: 'router', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [
      { name: 'quotedTokens', type: 'uint256' },
      { name: 'receivedTokens', type: 'uint256' },
      { name: 'quotedNative', type: 'uint256' },
      { name: 'recoveredNative', type: 'uint256' },
    ],
  },
] as const;
