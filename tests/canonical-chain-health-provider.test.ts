import assert from 'node:assert/strict';
import test from 'node:test';
import type { Hash } from 'viem';
import { CanonicalChainHealthProvider } from '../src/chain/canonical-chain-health.provider.js';
import type { ChainReorgAudit, CanonicalChainState } from '../src/chain/canonical-chain.types.js';
import type { CanonicalChainCoordinator } from '../src/chain/canonical-chain.coordinator.js';
import type { CanonicalChainRepository } from '../src/chain/canonical-chain.repository.js';

const HASH = `0x${'1'.repeat(64)}` as Hash;

function audit(status: ChainReorgAudit['status']): ChainReorgAudit {
  return {
    id: 'persisted-reorg',
    detectedAtMs: 1_753_700_000_000,
    commonAncestor: { number: 118n, hash: HASH },
    previousTip: { number: 120n, hash: HASH },
    replacementTip: { number: 120n, hash: HASH },
    status,
    impact: { depth: 2, orphanedEvents: 4, replayedEvents: 3 },
    details: {},
  };
}

function coordinator(state: {
  value: CanonicalChainState;
  lastReorg?: ReturnType<typeof audit> | null;
}): CanonicalChainCoordinator {
  const lastReorg = state.lastReorg;
  return {
    get currentStatus() {
      return {
        running: false,
        pendingRequests: 0,
        state: state.value,
        lastReorg: !lastReorg ? null : {
          detectedAtMs: lastReorg.detectedAtMs,
          ancestor: lastReorg.commonAncestor === null ? null : {
            ...lastReorg.commonAncestor,
            parentHash: HASH,
          },
          oldTip: { ...lastReorg.previousTip, parentHash: HASH },
          newTip: { ...lastReorg.replacementTip, parentHash: HASH },
          depth: lastReorg.impact.depth,
          status: lastReorg.status,
          impact: lastReorg.impact,
        },
      };
    },
  } as unknown as CanonicalChainCoordinator;
}

test('au redémarrage, expose le dernier audit persistant MANUAL_REVIEW et dégrade HEALTHY', async () => {
  const subject = new CanonicalChainHealthProvider(
    5,
    coordinator({ value: 'HEALTHY' }),
    {
      getCanonicalTip: async () => ({ number: 120n, hash: HASH, parentHash: HASH }),
      getLastReorg: async () => audit('MANUAL_REVIEW'),
    } as unknown as CanonicalChainRepository,
  );

  const health = await subject.getHealth(125n);

  assert.equal(health.state, 'MANUAL_REVIEW');
  assert.equal(health.lastReorg?.status, 'MANUAL_REVIEW');
  assert.equal(health.lastReorg?.commonAncestorNumber, '118');
  assert.equal(health.lastReorg?.orphanedEvents, 4);
});

test('ignore dans la santé courante un reorg antérieur au fresh-start', async () => {
  const persisted = audit('MANUAL_REVIEW');
  const subject = new CanonicalChainHealthProvider(
    5,
    coordinator({ value: 'HEALTHY' }),
    {
      getCanonicalTip: async () => ({
        number: 120n,
        hash: HASH,
        parentHash: HASH,
      }),
      getLastReorg: async () => persisted,
    } as unknown as CanonicalChainRepository,
    persisted.detectedAtMs + 1,
  );

  const health = await subject.getHealth(125n);

  assert.equal(health.state, 'HEALTHY');
  assert.equal(health.lastReorg, null);
});

test('un RECOVERED runtime du même reorg reste RECONCILING tant que DB ne confirme pas', async () => {
  const persisted = { ...audit('RECONCILING'), detectedAtMs: 1_753_700_000_100 };
  const inMemory = { ...audit('RECOVERED'), detectedAtMs: 1_753_700_000_000 };
  const subject = new CanonicalChainHealthProvider(
    5,
    coordinator({ value: 'HEALTHY', lastReorg: inMemory }),
    {
      getCanonicalTip: async () => ({ number: 120n, hash: HASH, parentHash: HASH }),
      getLastReorg: async () => persisted,
    } as unknown as CanonicalChainRepository,
  );

  const health = await subject.getHealth(125n);

  assert.equal(health.state, 'RECONCILING');
  assert.equal(health.lastReorg?.status, 'RECONCILING');
});

test('au redémarrage, l’audit DB RECOVERED finalisé est exposé', async () => {
  const subject = new CanonicalChainHealthProvider(
    5,
    coordinator({ value: 'HEALTHY' }),
    {
      getCanonicalTip: async () => ({ number: 120n, hash: HASH, parentHash: HASH }),
      getLastReorg: async () => audit('RECOVERED'),
    } as unknown as CanonicalChainRepository,
  );

  const health = await subject.getHealth(125n);
  assert.equal(health.state, 'HEALTHY');
  assert.equal(health.lastReorg?.status, 'RECOVERED');
});

test('lit le statut coordinateur après les I/O et ne retourne pas HEALTHY si une réconciliation démarre entre-temps', async () => {
  let state: CanonicalChainState = 'HEALTHY';
  let releaseTip!: () => void;
  const tip = new Promise<{ number: bigint; hash: Hash; parentHash: Hash }>((resolve) => {
    releaseTip = () => resolve({ number: 120n, hash: HASH, parentHash: HASH });
  });
  const subject = new CanonicalChainHealthProvider(
    5,
    coordinator({ get value() { return state; } }),
    {
      getCanonicalTip: async () => tip,
      getLastReorg: async () => null,
    } as unknown as CanonicalChainRepository,
  );

  const healthPromise = subject.getHealth(125n);
  state = 'RECONCILING';
  releaseTip();

  const health = await healthPromise;
  assert.equal(health.state, 'RECONCILING');
});
