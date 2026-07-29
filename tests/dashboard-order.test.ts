import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('trie MANUAL_REVIEW puis WAITING_FIRST_BUY avant LIMIT', async () => {
  const source = await readFile('src/dashboard/dashboard.ts', 'utf8');
  const manual = source.indexOf("WHEN s.status = 'MANUAL_REVIEW' THEN 0");
  const firstBuy = source.indexOf(
    "WHEN s.status = 'WAITING_FIRST_BUY' THEN 1",
  );
  const limit = source.indexOf('LIMIT $1');

  assert.ok(manual >= 0);
  assert.ok(firstBuy > manual);
  assert.ok(limit > firstBuy);
  assert.match(
    source,
    /COALESCE\(s\.updated_at,\s*d\.updated_at\) DESC,\s*d\.token_address ASC/u,
  );
});
