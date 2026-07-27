import assert from 'node:assert/strict';
import test from 'node:test';
import type { Hex } from 'viem';
import { functionSelector, scanSensitiveSelectors } from '../src/security/bytecode-scanner.js';

test('détecte le sélecteur mint', () => {
  const selector = functionSelector('mint(address,uint256)').slice(2);
  const matches = scanSensitiveSelectors(`0x6000${selector}6000` as Hex);
  assert.equal(matches.some((match) => match.signature === 'mint(address,uint256)'), true);
});
