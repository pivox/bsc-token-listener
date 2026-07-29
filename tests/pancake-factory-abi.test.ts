import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { pancakeFactoryAbi } from '../src/abi/pancake-factory.abi.js';

const token0 = '0x0000000000000000000000000000000000000001' as Address;
const token1 = '0x0000000000000000000000000000000000000002' as Address;
const pair = '0x0000000000000000000000000000000000000003' as Address;
const blockHash = `0x${'4'.repeat(64)}` as Hash;

test('décode PairCreated avec ses arguments nommés depuis un log confirmé', () => {
  const topics = encodeEventTopics({
    abi: pancakeFactoryAbi,
    eventName: 'PairCreated',
    args: { token0, token1 },
  }) as [Hex, ...Hex[]];
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

  const confirmedLog = { ...decoded, blockHash };

  assert.equal(confirmedLog.args.token0, token0);
  assert.equal(confirmedLog.args.token1, token1);
  assert.equal(confirmedLog.args.pair, pair);
  assert.equal(confirmedLog.args.allPairsLength, 1n);
  assert.equal(confirmedLog.blockHash, blockHash);
});
