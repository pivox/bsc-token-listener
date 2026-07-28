import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import type { SwapEvent, TokenSession } from '../src/types/domain.js';
import { isSessionMonitorable } from '../src/strategy/session-monitor-policy.js';
import {
  SessionEngine,
  type SwapEventLifecycle,
} from '../src/strategy/session-engine.js';
import type { TokenRiskReport } from '../src/security/token-risk.types.js';

const ADDRESS = `0x${'1'.repeat(40)}` as Address;

function buy(id: number): SwapEvent {
  return {
    id: `event-${id}`,
    pair: ADDRESS,
    transactionHash: `0x${id.toString(16).padStart(64, '0')}` as Hash,
    blockHash: `0x${id.toString(16).padStart(64, '0')}` as Hash,
    kind: 'BUY',
    sender: ADDRESS,
    recipient: ADDRESS,
    amount0In: 1n,
    amount1In: 0n,
    amount0Out: 0n,
    amount1Out: 1n,
    amountWbnb: 1n,
    amountToken: 1n,
    cursor: { blockNumber: BigInt(id), transactionIndex: 0, logIndex: 0 },
    observedAtMs: id,
  };
}

function allowReport(): TokenRiskReport {
  return {
    id: 'report',
    token: ADDRESS,
    pair: ADDRESS,
    blockNumber: 3n,
    score: 100,
    verdict: 'ALLOW',
    checks: [],
    summary: {
      liquidityWbnb: 1_000n,
      owner: null,
      implementation: null,
      lpBurnedBps: null,
      buyTaxBps: 0,
      sellTaxBps: 0,
      roundTripLossBps: 0,
      sensitiveSelectors: [],
    },
    createdAtMs: 3,
  };
}

function session(status: TokenSession['status']): TokenSession {
  return {
    pair: {} as TokenSession['pair'],
    metadata: {} as TokenSession['metadata'],
    status,
    subsequentBuyCount: 0,
    targetBuysAfterEntry: 3,
    countedBuyTransactionHashes: [],
    sellAttempts: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

class MemorySwapEventLifecycle implements SwapEventLifecycle {
  claimResult = true;
  markFailedError: Error | undefined;
  readonly claimed: Array<{ event: SwapEvent; before: TokenSession }> = [];
  readonly processed: Array<{ eventId: string; after: TokenSession }> = [];
  readonly failed: Array<{ eventId: string; reason: string }> = [];

  async claim(event: SwapEvent, before: TokenSession): Promise<boolean> {
    this.claimed.push({ event, before });
    return this.claimResult;
  }

  async markProcessed(eventId: string, after: TokenSession): Promise<void> {
    this.processed.push({ eventId, after });
  }

  async markFailed(eventId: string, reason: string): Promise<void> {
    this.failed.push({ eventId, reason });
    if (this.markFailedError) throw this.markFailedError;
  }
}

function waitingSession(): TokenSession {
  const value = session('WAITING_FIRST_BUY');
  value.pair = {
    pair: ADDRESS,
    token: ADDRESS,
  } as TokenSession['pair'];
  return value;
}

test('active uniquement les sessions qui peuvent consommer des swaps', () => {
  assert.equal(isSessionMonitorable(session('WAITING_FIRST_BUY')), true);
  assert.equal(isSessionMonitorable(session('HOLDING')), true);
  for (const status of [
    'RISK_CHECKING',
    'BUY_PENDING',
    'SELL_PENDING',
    'MANUAL_REVIEW',
    'CLOSED',
    'REJECTED',
    'EXPIRED',
  ] as const) {
    assert.equal(isSessionMonitorable(session(status)), false, status);
  }
});

test('laisse rejouable un swap arrivé après désactivation de la session', async () => {
  const current = session('MANUAL_REVIEW');
  current.pair = {
    pair: '0x0000000000000000000000000000000000000001',
  } as unknown as TokenSession['pair'];
  const engine = new SessionEngine(
    { findByPair: async () => structuredClone(current) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const consumed = await engine.onSwap(current, {
    id: 'event',
    pair: '0x0000000000000000000000000000000000000001',
    transactionHash:
      '0x0000000000000000000000000000000000000000000000000000000000000001',
    blockHash:
      '0x0000000000000000000000000000000000000000000000000000000000000001',
    kind: 'BUY',
    sender: '0x0000000000000000000000000000000000000001',
    recipient: '0x0000000000000000000000000000000000000001',
    amount0In: 0n,
    amount1In: 0n,
    amount0Out: 0n,
    amount1Out: 0n,
    amountWbnb: 0n,
    amountToken: 0n,
    cursor: { blockNumber: 2n, transactionIndex: 0, logIndex: 0 },
    observedAtMs: 2,
  });

  assert.equal(consumed, false);
  assert.equal(current.lastProcessedCursor, undefined);
});

test('sérialise l’expiration avec une entrée déjà en cours', async () => {
  let releaseRisk!: () => void;
  let signalRiskStarted!: () => void;
  const riskStarted = new Promise<void>((resolve) => {
    signalRiskStarted = resolve;
  });
  const riskRelease = new Promise<void>((resolve) => {
    releaseRisk = resolve;
  });
  const savedStatuses: TokenSession['status'][] = [];
  const current = session('WAITING_FIRST_BUY');
  current.pair = {
    pair: ADDRESS,
    token: ADDRESS,
  } as TokenSession['pair'];
  current.entryObservationBuys = [buy(1), buy(2)];
  current.createdAtMs = 0;

  const engine = new SessionEngine(
    {
      save: async (value: TokenSession) => {
        savedStatuses.push(value.status);
      },
      findByPair: async () => structuredClone(current),
      countOpenPositions: async () => 0,
    } as never,
    {} as never,
    {
      analyze: async () => {
        signalRiskStarted();
        await riskRelease;
        throw new Error('analyse indisponible');
      },
    } as never,
    {} as never,
    {} as never,
  );

  const entry = engine.onSwap(current, buy(3));
  await riskStarted;
  const expiration = engine.expireIfNeeded(current);
  releaseRisk();

  await entry;
  assert.equal(await expiration, false);
  assert.equal(current.status, 'REJECTED');
  assert.equal(savedStatuses.includes('EXPIRED'), false);
});

test('recharge la session persistée avant de l’ignorer après une entrée', async () => {
  let releaseRisk!: () => void;
  let signalRiskStarted!: () => void;
  const riskStarted = new Promise<void>((resolve) => {
    signalRiskStarted = resolve;
  });
  const riskRelease = new Promise<void>((resolve) => {
    releaseRisk = resolve;
  });
  const current = session('WAITING_FIRST_BUY');
  current.pair = {
    pair: ADDRESS,
    token: ADDRESS,
  } as TokenSession['pair'];
  current.entryObservationBuys = [buy(1), buy(2)];
  const staleWaiting = structuredClone(current);
  let persisted = structuredClone(current);
  const savedStatuses: TokenSession['status'][] = [];

  const engine = new SessionEngine(
    {
      save: async (value: TokenSession) => {
        persisted = structuredClone(value);
        savedStatuses.push(value.status);
      },
      findByPair: async () => structuredClone(persisted),
      countOpenPositions: async () => 0,
    } as never,
    { save: async () => {} } as never,
    {
      analyze: async () => {
        signalRiskStarted();
        await riskRelease;
        return allowReport();
      },
    } as never,
    {
      buy: async () => ({
        mode: 'dry-run',
        amountInWei: 100n,
        amountOutToken: 200n,
        confirmedAtMs: 4,
        cursor: { blockNumber: 3n, transactionIndex: 1, logIndex: 0 },
      }),
    } as never,
    { resolve: async () => 100n } as never,
  );

  const entry = engine.onSwap(current, buy(3));
  await riskStarted;
  const ignored = engine.ignoreManually(staleWaiting);
  releaseRisk();

  await entry;
  await assert.rejects(ignored, /position ouverte/u);
  assert.equal(persisted.status, 'HOLDING');
  assert.equal(savedStatuses.includes('REJECTED'), false);
});

test('capture les snapshots avant et après sous le verrou de paire', async () => {
  const current = waitingSession();
  current.entryObservationBuys = [buy(1), buy(2)];
  const detached = structuredClone(current);
  let persisted = structuredClone(current);
  const savedSessions: TokenSession[] = [];
  const events = new MemorySwapEventLifecycle();
  const savedReports: Array<{ report: TokenRiskReport; sourceEventId?: string }> = [];
  const savedTrades: Array<{ sourceEventId?: string }> = [];
  const engine = new SessionEngine(
    {
      save: async (value: TokenSession) => {
        persisted = structuredClone(value);
        savedSessions.push(structuredClone(value));
      },
      findByPair: async () => structuredClone(persisted),
      countOpenPositions: async () => 0,
    } as never,
    {
      save: async (report: TokenRiskReport, sourceEventId?: string) => {
        savedReports.push({ report, ...(sourceEventId ? { sourceEventId } : {}) });
      },
    } as never,
    { analyze: async () => allowReport() } as never,
    {
      buy: async (
        _session: TokenSession,
        _amount: bigint,
        sourceEventId?: string,
      ) => {
        savedTrades.push({ ...(sourceEventId ? { sourceEventId } : {}) });
        return {
          mode: 'dry-run',
          amountInWei: 100n,
          amountOutToken: 200n,
          confirmedAtMs: 4,
          cursor: { blockNumber: 3n, transactionIndex: 1, logIndex: 0 },
        };
      },
    } as never,
    { resolve: async () => 100n } as never,
    undefined,
    events,
  );
  const event = buy(3);

  await engine.onSwap(detached, event);
  detached.status = 'EXPIRED';
  detached.entryObservationBuys = [];

  assert.equal(events.claimed[0]?.before.status, 'WAITING_FIRST_BUY');
  assert.equal(events.claimed[0]?.before.entryObservationBuys?.length, 2);
  assert.equal(events.processed[0]?.after.status, 'HOLDING');
  assert.equal(events.processed[0]?.after.entryObservationBuys?.length, 3);
  assert.equal(savedReports[0]?.sourceEventId, event.id);
  assert.equal(savedTrades[0]?.sourceEventId, event.id);
  assert.equal(
    savedSessions.find(({ status }) => status === 'RISK_CHECKING')
      ?.pendingExecutionSourceEventId,
    event.id,
  );
  assert.equal(
    savedSessions.find(({ status }) => status === 'BUY_PENDING')
      ?.pendingExecutionSourceEventId,
    event.id,
  );
  assert.equal(events.processed[0]?.after.pendingExecutionSourceEventId, undefined);
});

test('ne rejoue pas un doublon canonique non réclamé', async () => {
  const current = waitingSession();
  const events = new MemorySwapEventLifecycle();
  events.claimResult = false;
  let riskCalls = 0;
  const engine = new SessionEngine(
    { findByPair: async () => structuredClone(current) } as never,
    {} as never,
    {
      analyze: async () => {
        riskCalls += 1;
        return allowReport();
      },
    } as never,
    {} as never,
    {} as never,
    undefined,
    events,
  );

  assert.equal(await engine.onSwap(current, buy(1)), true);
  assert.equal(riskCalls, 0);
  assert.equal(events.processed.length, 0);
  assert.equal(events.failed.length, 0);
});

test('marque l’événement en échec sans snapshot après si le traitement échoue', async () => {
  const current = waitingSession();
  const events = new MemorySwapEventLifecycle();
  const engine = new SessionEngine(
    {
      findByPair: async () => structuredClone(current),
      save: async () => {
        throw new Error('session indisponible');
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    events,
  );
  const event = buy(1);

  await assert.rejects(engine.onSwap(current, event), /session indisponible/u);
  assert.equal(events.processed.length, 0);
  assert.deepEqual(events.failed, [{
    eventId: event.id,
    reason: 'session indisponible',
  }]);
});

test('préserve l’erreur de traitement si le marquage FAILED échoue aussi', async () => {
  const current = waitingSession();
  const handlingError = new Error('session indisponible');
  const events = new MemorySwapEventLifecycle();
  events.markFailedError = new Error('registre événements indisponible');
  const engine = new SessionEngine(
    {
      findByPair: async () => structuredClone(current),
      save: async () => {
        throw handlingError;
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    events,
  );

  await assert.rejects(
    engine.onSwap(current, buy(1)),
    (error: unknown) => error === handlingError,
  );
  assert.deepEqual(events.failed, [{
    eventId: 'event-1',
    reason: 'session indisponible',
  }]);
});

test('persiste la provenance avant une vente SELL_PENDING interrompue', async () => {
  const current = waitingSession();
  current.status = 'HOLDING';
  current.targetBuysAfterEntry = 1;
  current.entry = {
    mode: 'dry-run',
    amountInWei: 100n,
    amountOutToken: 200n,
    confirmedAtMs: 1,
    cursor: { blockNumber: 0n, transactionIndex: 0, logIndex: 0 },
  };
  let persisted = structuredClone(current);
  let sellCalls = 0;
  const engine = new SessionEngine(
    {
      findByPair: async () => structuredClone(persisted),
      save: async (value: TokenSession) => {
        persisted = structuredClone(value);
        if (value.status === 'SELL_PENDING') {
          throw new Error('crash avant création du trade');
        }
      },
    } as never,
    {} as never,
    {} as never,
    {
      sell: async () => {
        sellCalls += 1;
        throw new Error('vente inattendue');
      },
    } as never,
    {} as never,
  );
  const event = buy(4);

  await assert.rejects(
    engine.onSwap(current, event),
    /crash avant création du trade/u,
  );

  assert.equal(sellCalls, 0);
  assert.equal(persisted.status, 'SELL_PENDING');
  assert.equal(persisted.pendingExecutionSourceEventId, event.id);
});

test('une vente manuelle n’hérite jamais d’une provenance résiduelle', async () => {
  const current = waitingSession();
  current.status = 'HOLDING';
  current.pendingExecutionSourceEventId = 'event-obsolete';
  current.entry = {
    mode: 'dry-run',
    amountInWei: 100n,
    amountOutToken: 200n,
    confirmedAtMs: 1,
    cursor: { blockNumber: 0n, transactionIndex: 0, logIndex: 0 },
  };
  let sellSourceEventId: string | undefined;
  const engine = new SessionEngine(
    { save: async () => {} } as never,
    {} as never,
    {} as never,
    {
      sell: async (
        _session: TokenSession,
        _recovered: undefined,
        sourceEventId?: string,
      ) => {
        sellSourceEventId = sourceEventId;
        return {
          mode: 'dry-run',
          amountInToken: 200n,
          amountOutWei: 100n,
          confirmedAtMs: 2,
        };
      },
    } as never,
    {} as never,
  );

  await engine.sellManually(current);

  assert.equal(sellSourceEventId, undefined);
  assert.equal(current.pendingExecutionSourceEventId, undefined);
});

test('sérialise les snapshots de swaps concurrents pour une même paire', async () => {
  let persisted = waitingSession();
  const events = new MemorySwapEventLifecycle();
  const engine = new SessionEngine(
    {
      findByPair: async () => structuredClone(persisted),
      save: async (value: TokenSession) => {
        persisted = structuredClone(value);
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    events,
  );

  await Promise.all([
    engine.onSwap(structuredClone(persisted), buy(1)),
    engine.onSwap(structuredClone(persisted), buy(2)),
  ]);

  assert.deepEqual(
    events.claimed.map(({ before }) => before.entryObservationBuys?.length ?? 0),
    [0, 1],
  );
  assert.deepEqual(
    events.processed.map(({ after }) => after.entryObservationBuys?.length ?? 0),
    [1, 2],
  );
});
