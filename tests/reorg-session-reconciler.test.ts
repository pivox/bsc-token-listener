import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import {
  ReorgSessionReconciler,
  type ReorgSessionStore,
} from '../src/chain/reorg-session-reconciler.js';
import type {
  ReorgRollbackImpact,
  ReorgRollbackPairImpact,
} from '../src/chain/canonical-chain.types.js';
import type {
  SwapEvent,
  TokenSession,
  TradeRecord,
  TradeTransactionRecord,
} from '../src/types/domain.js';

const FACTORY = `0x${'1'.repeat(40)}` as Address;
const ROUTER = `0x${'2'.repeat(40)}` as Address;
const WBNB = `0x${'3'.repeat(40)}` as Address;
const TOKEN = `0x${'4'.repeat(40)}` as Address;
const PAIR_A = `0x${'a'.repeat(40)}` as Address;
const PAIR_B = `0x${'b'.repeat(40)}` as Address;
const BLOCK_HASH = `0x${'5'.repeat(64)}` as Hash;
const ENTRY_HASH = `0x${'6'.repeat(64)}` as Hash;
const ORPHAN_HASH = `0x${'7'.repeat(64)}` as Hash;
const CANONICAL_HASH_1 = `0x${'8'.repeat(64)}` as Hash;
const CANONICAL_HASH_2 = `0x${'9'.repeat(64)}` as Hash;
const CASE_HASH_LOWER = `0x${'a'.repeat(64)}` as Hash;
const CASE_HASH_UPPER = `0x${'A'.repeat(64)}` as Hash;

function session(
  pair: Address,
  status: TokenSession['status'] = 'WAITING_FIRST_BUY',
): TokenSession {
  return {
    pair: {
      factory: FACTORY,
      router: ROUTER,
      wbnb: WBNB,
      pair,
      token: TOKEN,
      token0: TOKEN,
      token1: WBNB,
      createdBlock: 10n,
      blockHash: BLOCK_HASH,
      createdTransactionHash: ENTRY_HASH,
      createdLogIndex: 0,
      discoveredAtMs: 1,
    },
    metadata: {
      address: TOKEN,
      name: 'Token',
      symbol: 'TKN',
      decimals: 18,
      totalSupply: 1_000n,
      codeSizeBytes: 1,
    },
    status,
    subsequentBuyCount: 0,
    targetBuysAfterEntry: 3,
    countedBuyTransactionHashes: [],
    sellAttempts: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function swap(
  pair: Address,
  id: string,
  transactionHash: Hash,
  blockNumber: bigint,
  transactionIndex = 0,
  logIndex = 0,
  kind: SwapEvent['kind'] = 'BUY',
): SwapEvent {
  return {
    id,
    pair,
    transactionHash,
    blockHash: BLOCK_HASH,
    kind,
    sender: FACTORY,
    recipient: ROUTER,
    amount0In: 1n,
    amount1In: 0n,
    amount0Out: 0n,
    amount1Out: 1n,
    amountWbnb: 1n,
    amountToken: 1n,
    cursor: { blockNumber, transactionIndex, logIndex },
    observedAtMs: Number(blockNumber),
  };
}

function affected(
  pairAddress: Address,
  overrides: Partial<ReorgRollbackPairImpact> = {},
): ReorgRollbackPairImpact {
  return {
    pairAddress,
    discoveryOrphaned: false,
    earliestSessionBefore: null,
    latestCanonicalSessionAfter: null,
    hasWalletConsequence: false,
    ...overrides,
  };
}

function impact(
  affectedPairs: readonly ReorgRollbackPairImpact[],
): ReorgRollbackImpact {
  return {
    reorgId: 'reorg:test',
    depth: 1,
    orphanedEvents: 1,
    replayedEvents: 0,
    orphanedEventIds: ['orphan-event'],
    affectedPairs,
  };
}

interface SavedSession {
  session: TokenSession;
  canonical: boolean;
}

class MemoryReorgSessionStore implements ReorgSessionStore {
  readonly saved: SavedSession[] = [];
  readonly accountingWrites: string[] = [];
  readonly sessions = new Map<string, TokenSession>();
  readonly canonicalEvents = new Map<string, readonly SwapEvent[]>();
  readonly trades: TradeRecord[] = [];
  readonly transactions: TradeTransactionRecord[] = [];
  readonly dryRunAuditRows: Array<{ id: string; canonical: boolean }> = [];

  async findSession(pair: Address): Promise<TokenSession | null> {
    return structuredClone(this.sessions.get(pair.toLowerCase()) ?? null);
  }

  async listCanonicalProcessedEvents(
    pair: Address,
  ): Promise<readonly SwapEvent[]> {
    return structuredClone(
      this.canonicalEvents.get(pair.toLowerCase()) ?? [],
    );
  }

  async saveReconciledSession(
    value: TokenSession,
    canonical: boolean,
  ): Promise<void> {
    this.saved.push({ session: structuredClone(value), canonical });
    this.sessions.set(value.pair.pair.toLowerCase(), structuredClone(value));
  }

  async deleteTrade(): Promise<void> {
    this.accountingWrites.push('delete-trade');
  }

  async rewriteTradeStatus(): Promise<void> {
    this.accountingWrites.push('rewrite-trade-status');
  }

  async deleteTransaction(): Promise<void> {
    this.accountingWrites.push('delete-transaction');
  }

  async rewriteTransactionStatus(): Promise<void> {
    this.accountingWrites.push('rewrite-transaction-status');
  }
}

test('une découverte de paire orpheline sans trade rejette les sessions non canoniques et arrête les moniteurs dans un ordre déterministe', async () => {
  const store = new MemoryReorgSessionStore();
  store.sessions.set(PAIR_A, session(PAIR_A));
  store.sessions.set(PAIR_B, session(PAIR_B));
  const reconciler = new ReorgSessionReconciler(store, () => 20);

  const result = await reconciler.reconcile(impact([
    affected(PAIR_B, { discoveryOrphaned: true }),
    affected(PAIR_A, { discoveryOrphaned: true }),
  ]));

  assert.deepEqual(
    store.saved.map(({ session: saved }) => saved.pair.pair),
    [PAIR_A, PAIR_B],
  );
  assert.ok(store.saved.every(({ canonical }) => canonical === false));
  assert.ok(store.saved.every(({ session: saved }) =>
    saved.status === 'REJECTED'
  ));
  assert.deepEqual(result.monitorsToStop, [PAIR_A, PAIR_B]);
});

test('un premier achat orphelin restaure WAITING_FIRST_BUY sans rapport de risque ni observation obsolète', async () => {
  const store = new MemoryReorgSessionStore();
  const orphan = swap(PAIR_A, 'orphan-event', ORPHAN_HASH, 12n);
  const current = session(PAIR_A, 'RISK_CHECKING');
  current.firstBuy = orphan;
  current.entryObservationBuys = [orphan];
  current.riskReportId = 'risk-orphan';
  store.sessions.set(PAIR_A, current);
  store.dryRunAuditRows.push({ id: 'dry-run-orphan', canonical: false });
  const before = structuredClone(current);
  before.status = 'WAITING_FIRST_BUY';
  const reconciler = new ReorgSessionReconciler(store, () => 20);

  await reconciler.reconcile(impact([
    affected(PAIR_A, { earliestSessionBefore: before }),
  ]));

  const saved = store.saved[0];
  assert.equal(saved?.session.status, 'WAITING_FIRST_BUY');
  assert.equal(saved?.session.firstBuy, undefined);
  assert.equal(saved?.session.entryObservationBuys, undefined);
  assert.equal(saved?.session.riskReportId, undefined);
  assert.deepEqual(store.dryRunAuditRows, [
    { id: 'dry-run-orphan', canonical: false },
  ]);
});

test('un achat post-entrée orphelin reconstruit hashes et compteur depuis les seuls événements canoniques traités', async () => {
  const store = new MemoryReorgSessionStore();
  const current = session(PAIR_A, 'HOLDING');
  current.entry = {
    mode: 'dry-run',
    amountInWei: 10n,
    amountOutToken: 20n,
    confirmedAtMs: 10,
    cursor: { blockNumber: 10n, transactionIndex: 1, logIndex: 0 },
    transactionHash: ENTRY_HASH,
  };
  current.countedBuyTransactionHashes = [ORPHAN_HASH, CANONICAL_HASH_1];
  current.subsequentBuyCount = 2;
  store.sessions.set(PAIR_A, current);
  store.canonicalEvents.set(PAIR_A, [
    swap(PAIR_A, 'canonical-2', CANONICAL_HASH_2, 13n),
    swap(PAIR_A, 'sell', ORPHAN_HASH, 14n, 0, 0, 'SELL'),
    swap(PAIR_A, 'entry', ENTRY_HASH, 11n),
    swap(PAIR_A, 'canonical-1-duplicate', CANONICAL_HASH_1, 12n, 1),
    swap(PAIR_A, 'before-entry', ORPHAN_HASH, 10n, 0),
    swap(PAIR_A, 'canonical-1', CANONICAL_HASH_1, 12n, 0),
  ]);
  const reconciler = new ReorgSessionReconciler(store, () => 20);

  await reconciler.reconcile(impact([
    affected(PAIR_A, { earliestSessionBefore: current }),
  ]));

  const savedSession = store.saved[0]?.session;
  assert.deepEqual(savedSession?.countedBuyTransactionHashes, [
    CANONICAL_HASH_1,
    CANONICAL_HASH_2,
  ]);
  assert.equal(savedSession?.subsequentBuyCount, 2);
});

test('un replay déduplique les hashes sans tenir compte de la casse et persiste leur forme lowercase', async () => {
  const store = new MemoryReorgSessionStore();
  const current = session(PAIR_A, 'HOLDING');
  current.entry = {
    mode: 'dry-run',
    amountInWei: 10n,
    amountOutToken: 20n,
    confirmedAtMs: 10,
    cursor: { blockNumber: 10n, transactionIndex: 0, logIndex: 0 },
    transactionHash: ENTRY_HASH,
  };
  store.sessions.set(PAIR_A, current);
  store.canonicalEvents.set(PAIR_A, [
    swap(PAIR_A, 'uppercase', CASE_HASH_UPPER, 11n),
    swap(PAIR_A, 'lowercase-replay', CASE_HASH_LOWER, 12n),
  ]);
  const reconciler = new ReorgSessionReconciler(store, () => 20);
  const reorgImpact = impact([
    affected(PAIR_A, { earliestSessionBefore: current }),
  ]);

  await reconciler.reconcile(reorgImpact);
  await reconciler.reconcile(reorgImpact);

  const replayedSession = store.saved.at(-1)?.session;
  assert.deepEqual(replayedSession?.countedBuyTransactionHashes, [
    CASE_HASH_LOWER,
  ]);
  assert.equal(replayedSession?.subsequentBuyCount, 1);
});

test('une projection legacy sans snapshot passe en revue manuelle au lieu de restaurer la session contaminée', async () => {
  const store = new MemoryReorgSessionStore();
  const contaminated = session(PAIR_A, 'HOLDING');
  contaminated.countedBuyTransactionHashes = [ORPHAN_HASH];
  contaminated.subsequentBuyCount = 1;
  store.sessions.set(PAIR_A, contaminated);
  const reconciler = new ReorgSessionReconciler(store, () => 20);

  await reconciler.reconcile(impact([affected(PAIR_A)]));

  const savedSession = store.saved[0]?.session;
  assert.equal(savedSession?.status, 'MANUAL_REVIEW');
  assert.match(savedSession?.rejectionReason ?? '', /réorganisation/u);
  assert.match(savedSession?.rejectionReason ?? '', /snapshot.*reconstruct/u);
});

test('une découverte orpheline avec conséquence wallet conserve accounting sans arrêter le moniteur', async () => {
  const store = new MemoryReorgSessionStore();
  const current = session(PAIR_A, 'HOLDING');
  store.sessions.set(PAIR_A, current);
  store.trades.push({
    id: 'trade-1',
    sourceEventId: 'orphan-event',
    pair: PAIR_A,
    token: TOKEN,
    side: 'BUY',
    mode: 'live',
    status: 'CONFIRMED',
    amountIn: 10n,
    amountOut: 20n,
    createdAtMs: 10,
    updatedAtMs: 10,
  });
  store.transactions.push({
    id: 'transaction-1',
    tradeId: 'trade-1',
    step: 'BUY',
    status: 'CONFIRMED',
    walletAddress: FACTORY,
    transactionHash: ENTRY_HASH,
    nonce: 1n,
    toAddress: ROUTER,
    valueWei: 10n,
    createdAtMs: 10,
    updatedAtMs: 10,
  });
  const tradesBefore = structuredClone(store.trades);
  const transactionsBefore = structuredClone(store.transactions);
  const reconciler = new ReorgSessionReconciler(store, () => 20);

  const result = await reconciler.reconcile(impact([
    affected(PAIR_A, {
      discoveryOrphaned: true,
      hasWalletConsequence: true,
    }),
  ]));

  assert.deepEqual(result.monitorsToStop, []);
  assert.deepEqual(store.trades, tradesBefore);
  assert.deepEqual(store.transactions, transactionsBefore);
  assert.deepEqual(store.accountingWrites, []);
  const savedSession = store.saved[0]?.session;
  assert.equal(savedSession?.status, 'MANUAL_REVIEW');
  assert.match(savedSession?.rejectionReason ?? '', /réorganisation/u);
});
