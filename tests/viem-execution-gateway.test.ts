import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, type Address, type Hex } from 'viem';
import { preparedTransactionFromSigned } from '../src/execution/viem-execution.gateway.js';

test('dérive le hash et conserve le nonce exact avant diffusion', () => {
  const serializedTransaction = '0x123456' as Hex;
  const walletAddress = `0x${'1'.repeat(40)}` as Address;
  const toAddress = `0x${'2'.repeat(40)}` as Address;

  const prepared = preparedTransactionFromSigned({
    step: 'BUY',
    nonce: 9_007_199_254_740_993n,
    walletAddress,
    toAddress,
    valueWei: 100n,
    serializedTransaction,
  });

  assert.equal(prepared.hash, keccak256(serializedTransaction));
  assert.equal(prepared.nonce, 9_007_199_254_740_993n);
  assert.equal(prepared.serializedTransaction, serializedTransaction);
});
