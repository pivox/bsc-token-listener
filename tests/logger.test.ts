import assert from 'node:assert/strict';
import test from 'node:test';
import { redactSensitiveText } from '../src/utils/logger.js';

test('masque le chemin secret d’une URL RPC', () => {
  assert.equal(
    redactSensitiveText('RPC https://example.test/v1/cle-secrete en échec'),
    'RPC https://example.test/[REDACTED_PATH] en échec',
  );
});

test('masque un en-tête Authorization', () => {
  assert.equal(
    redactSensitiveText('Authorization: Bearer abc.def-123'),
    'Authorization: Bearer [REDACTED]',
  );
});


test('masque aussi une clé RPC placée dans la query string', () => {
  assert.equal(
    redactSensitiveText('wss://example.test?apiKey=secret'),
    'wss://example.test/[REDACTED_PATH]',
  );
});
