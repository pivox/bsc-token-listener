import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  type Address,
} from 'viem';
import { pancakeFactoryAbi } from '../src/abi/pancake-factory.abi.js';

const token0 = '0x0000000000000000000000000000000000000001' as Address;
const token1 = '0x0000000000000000000000000000000000000002' as Address;
const pair = '0x0000000000000000000000000000000000000003' as Address;

test('décode PairCreated avec des arguments nommés', () => {
  const topics = encodeEventTopics({
    abi: pancakeFactoryAbi,
    eventName: 'PairCreated',
    args: { token0, token1 },
  });
  const data = encodeAbiParameters(
    [
      { name: 'pair', type: 'address' },
      { name: 'allPairsLength', type: 'uint256' },
    ],
    [pair, 1n],
  );

  const decoded = decodeEventLog({
    abi: pancakeFactoryAbi,
    eventName: 'PairCreated',
    topics,
    data,
  });

  assert.equal(decoded.args.token0, token0);
  assert.equal(decoded.args.token1, token1);
  assert.equal(decoded.args.pair, pair);
  assert.equal(decoded.args.allPairsLength, 1n);
});
