import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import { SessionRepository } from '../src/storage/repositories.js';
import { PositionExitSettingsProvider } from '../src/strategy/position-exit-settings.provider.js';
import { defaultPositionExitSettings } from '../src/strategy/position-exit-settings.js';
import type { EffectivePositionExitSettings } from '../src/strategy/position-exit.types.js';
import type { TokenSession } from '../src/types/domain.js';
import { isTokenSession } from '../src/types/domain-validation.js';

const ADDRESS = '0x1111111111111111111111111111111111111111' as Address;
const TOKEN = '0x2222222222222222222222222222222222222222' as Address;
const HASH = `0x${'1'.repeat(64)}` as Hash;

function session(): TokenSession {
  return {
    pair: {
      factory: ADDRESS,
      router: ADDRESS,
      wbnb: ADDRESS,
      pair: ADDRESS,
      token: TOKEN,
      token0: ADDRESS,
      token1: TOKEN,
      createdBlock: 1n,
      blockHash: HASH,
      createdTransactionHash: HASH,
      createdLogIndex: 0,
      discoveredAtMs: 1,
    },
    metadata: {
      address: TOKEN,
      name: null,
      symbol: null,
      decimals: 18,
      totalSupply: 1n,
      codeSizeBytes: 1,
    },
    status: 'HOLDING',
    subsequentBuyCount: 0,
    targetBuysAfterEntry: 3,
    countedBuyTransactionHashes: [],
    sellAttempts: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
    exitPolicy: {
      referenceLiquidityWbnbWei: 100n,
      latestNetValueWei: 90n,
      lastProbeStatus: 'SAFE',
      settingsRevision: 2,
    },
    pendingExitDecisionId: 'decision-1',
  };
}

test('valide strictement l’état de sortie persistant', () => {
  assert.equal(isTokenSession(session()), true);
  assert.equal(
    isTokenSession({
      ...session(),
      exitPolicy: { ...session().exitPolicy, lastProbeStatus: 'MAYBE' },
    }),
    false,
  );
  assert.equal(
    isTokenSession({
      ...session(),
      exitPolicy: { ...session().exitPolicy, unknown: true },
    }),
    false,
  );
});

test('charge uniquement les sessions HOLDING', async () => {
  const calls: string[] = [];
  const repository = new SessionRepository({
    query: async <T>(sql: string) => {
      calls.push(sql);
      return { rows: [] as T[] };
    },
  });

  assert.deepEqual(await repository.loadHolding(), []);
  assert.match(calls[0] ?? '', /status = 'HOLDING'/u);
});

test('utilise les valeurs environnement en révision zéro sans override', async () => {
  const defaults = defaultPositionExitSettings();
  const provider = new PositionExitSettingsProvider(
    {
      getSettings: async () => null,
      saveSettings: async () => {
        throw new Error('unexpected');
      },
      resetSettings: async () => {
        throw new Error('unexpected');
      },
    },
    defaults,
  );

  const result = await provider.get();
  assert.equal(result.revision, 0);
  assert.equal(result.source, 'ENV');
  assert.deepEqual(result.settings, defaults);
  assert.equal(Object.isFrozen(result.settings), true);
});

test('rafraîchit les réglages persistés par un autre processus', async () => {
  let persisted: EffectivePositionExitSettings | null = null;
  const provider = new PositionExitSettingsProvider(
    {
      getSettings: async () => persisted,
      saveSettings: async () => {
        throw new Error('unexpected');
      },
      resetSettings: async () => {
        throw new Error('unexpected');
      },
    },
    defaultPositionExitSettings(),
  );

  assert.equal((await provider.get()).source, 'ENV');
  persisted = {
    settings: Object.freeze({
      ...defaultPositionExitSettings(),
      stopLossBps: 2_500,
    }),
    revision: 4,
    source: 'DATABASE',
    updatedAt: new Date(0).toISOString(),
  };
  const refreshed = await provider.get();
  assert.equal(refreshed.revision, 4);
  assert.equal(refreshed.settings.stopLossBps, 2_500);
});

test('ne publie une révision qu’après le commit du repository', async () => {
  let fail = true;
  let persisted: EffectivePositionExitSettings | null = null;
  const committed: EffectivePositionExitSettings = {
    settings: Object.freeze({
      ...defaultPositionExitSettings(),
      stopLossBps: 2_000,
    }),
    revision: 1,
    source: 'DATABASE',
    updatedAt: new Date(0).toISOString(),
  };
  const provider = new PositionExitSettingsProvider(
    {
      getSettings: async () => persisted,
      saveSettings: async () => {
        if (fail) throw new Error('commit impossible');
        persisted = committed;
        return committed;
      },
      resetSettings: async () => {
        throw new Error('unexpected');
      },
    },
    defaultPositionExitSettings(),
  );
  await provider.get();

  await assert.rejects(
    provider.update(committed.settings, 0),
    /commit impossible/u,
  );
  assert.equal((await provider.get()).revision, 0);

  fail = false;
  assert.equal((await provider.update(committed.settings, 0)).revision, 1);
  assert.equal((await provider.get()).settings.stopLossBps, 2_000);
});

test('la migration de politique de sortie est idempotente', async () => {
  const sql = await readFile('migrations/008_position_exit_policy.sql', 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS strategy_settings/u);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS strategy_settings_audit/u);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS position_exit_decisions/u);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS/u);
  assert.match(sql, /UNIQUE\s*\(setting_key,\s*revision\)/u);
  assert.match(sql, /idempotency_key TEXT NOT NULL UNIQUE/u);
});
