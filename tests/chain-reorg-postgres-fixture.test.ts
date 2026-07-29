import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { schemaName } from './postgres/schema-name.js';

test('normalise les labels PostgreSQL contenant des tirets en identifiants sûrs', () => {
  const schema = schemaName('chain_reorg', 'pair-created');

  assert.match(schema, /^chain_reorg_pair_created_[a-f0-9]{32}$/u);
});

test('le schéma PostgreSQL isolé normalise le label de scénario avant interpolation SQL', async () => {
  const source = await readFile('tests/postgres/chain-reorg.test.ts', 'utf8');

  assert.match(source, /schemaName\('chain_reorg', name\)/u);
  assert.doesNotMatch(source, /chain_reorg_\$\{name\}_/u);
  assert.match(
    source,
    /await scoped\.drain\(\);[\s\S]*?await client\.query\(`DROP SCHEMA/u,
  );
  assert.match(source, /await failingDatabase\.drain\(\);/u);
  assert.match(source, /UPDATE chain_reorgs SET orphaned_events/u);
  assert.match(
    source,
    /new Coordinator\(\{[\s\S]*?reconcileReorg:[\s\S]*?rewindToAncestor/u,
  );
  assert.match(source, /un signal de vente dry-run disparu/u);
});
