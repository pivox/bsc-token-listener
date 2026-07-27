import type { Hash } from 'viem';
import type {
  ChainCursor,
  ClassifiedSwap,
  EntrySnapshot,
  ExitSnapshot,
  PairInfo,
  SessionSnapshot,
  TokenMetadata,
} from '../types/domain.js';
import { compareCursor } from '../utils/cursor.js';

const terminalStatuses = new Set(['CLOSED', 'REJECTED', 'EXPIRED', 'ERROR']);

export class TokenSession {
  private constructor(private readonly state: SessionSnapshot) {}

  public static create(pair: PairInfo, targetBuysAfterEntry: number): TokenSession {
    const now = Date.now();
    return new TokenSession({
      pair,
      status: 'WAITING_FIRST_BUY',
      targetBuysAfterEntry,
      metadata: undefined,
      firstBuy: undefined,
      entry: undefined,
      exit: undefined,
      subsequentBuyCount: 0,
      countedBuyTransactionHashes: [],
      lastProcessedCursor: undefined,
      rejectionReason: undefined,
      lastError: undefined,
      sellAttempts: 0,
      createdAtMs: now,
      updatedAtMs: now,
    });
  }

  public static restore(snapshot: SessionSnapshot): TokenSession {
    return new TokenSession(structuredClone(snapshot));
  }

  public get snapshot(): SessionSnapshot {
    return structuredClone(this.state);
  }

  public get pair(): PairInfo {
    return this.state.pair;
  }

  public get status(): SessionSnapshot['status'] {
    return this.state.status;
  }

  public get isTerminal(): boolean {
    return terminalStatuses.has(this.state.status);
  }

  public get isHolding(): boolean {
    return this.state.status === 'HOLDING' || this.state.status === 'SELL_PENDING';
  }

  public setMetadata(metadata: TokenMetadata): void {
    this.state.metadata = metadata;
    this.touch();
  }

  public recordProcessedCursor(cursor: ChainCursor): void {
    if (
      this.state.lastProcessedCursor === undefined ||
      compareCursor(cursor, this.state.lastProcessedCursor) > 0
    ) {
      this.state.lastProcessedCursor = cursor;
      this.touch();
    }
  }

  public recordFirstBuy(event: ClassifiedSwap): void {
    this.assertStatus('WAITING_FIRST_BUY');
    if (event.kind !== 'BUY') {
      throw new Error('Le premier événement de déclenchement doit être un achat.');
    }
    this.state.firstBuy = event;
    this.state.status = 'CHECKING';
    this.recordProcessedCursor(event.cursor);
    this.touch();
  }

  public markBuyPending(): void {
    this.assertStatus('CHECKING');
    this.state.status = 'BUY_PENDING';
    this.touch();
  }

  public markHolding(entry: EntrySnapshot): void {
    this.assertStatus('BUY_PENDING');
    this.state.entry = entry;
    this.state.status = 'HOLDING';
    this.state.lastError = undefined;
    this.recordProcessedCursor(entry.cursor);
    this.touch();
  }

  public recordSubsequentBuy(event: ClassifiedSwap): boolean {
    if (this.state.status !== 'HOLDING') {
      return false;
    }
    if (event.kind !== 'BUY' || this.state.entry === undefined) {
      this.recordProcessedCursor(event.cursor);
      return false;
    }
    if (compareCursor(event.cursor, this.state.entry.cursor) <= 0) {
      this.recordProcessedCursor(event.cursor);
      return false;
    }
    if (
      this.state.entry.transactionHash !== undefined &&
      event.transactionHash.toLowerCase() === this.state.entry.transactionHash.toLowerCase()
    ) {
      this.recordProcessedCursor(event.cursor);
      return false;
    }

    const alreadyCounted = this.state.countedBuyTransactionHashes.some(
      (hash: Hash) => hash.toLowerCase() === event.transactionHash.toLowerCase(),
    );
    if (alreadyCounted) {
      this.recordProcessedCursor(event.cursor);
      return false;
    }

    this.state.countedBuyTransactionHashes.push(event.transactionHash);
    this.state.subsequentBuyCount += 1;
    this.recordProcessedCursor(event.cursor);
    this.touch();
    return true;
  }

  public shouldSell(): boolean {
    return (
      this.state.status === 'HOLDING' &&
      this.state.subsequentBuyCount >= this.state.targetBuysAfterEntry
    );
  }

  public markSellPending(): void {
    this.assertStatus('HOLDING');
    this.state.status = 'SELL_PENDING';
    this.state.sellAttempts += 1;
    this.touch();
  }

  public markSellFailed(message: string): void {
    this.assertStatus('SELL_PENDING');
    this.state.status = 'HOLDING';
    this.state.lastError = message;
    this.touch();
  }

  public markClosed(exit: ExitSnapshot): void {
    this.assertStatus('SELL_PENDING');
    this.state.exit = exit;
    this.state.status = 'CLOSED';
    this.state.lastError = undefined;
    this.recordProcessedCursor(exit.cursor);
    this.touch();
  }

  public reject(reason: string): void {
    if (this.isTerminal) {
      return;
    }
    this.state.status = 'REJECTED';
    this.state.rejectionReason = reason;
    this.touch();
  }

  public expire(reason: string): void {
    if (this.state.status !== 'WAITING_FIRST_BUY') {
      return;
    }
    this.state.status = 'EXPIRED';
    this.state.rejectionReason = reason;
    this.touch();
  }

  public markError(error: unknown): void {
    this.state.status = 'ERROR';
    this.state.lastError = error instanceof Error ? error.message : String(error);
    this.touch();
  }

  public isWaitingExpired(nowMs: number, timeoutSeconds: number): boolean {
    return (
      this.state.status === 'WAITING_FIRST_BUY' &&
      nowMs - this.state.createdAtMs >= timeoutSeconds * 1000
    );
  }

  private assertStatus(expected: SessionSnapshot['status']): void {
    if (this.state.status !== expected) {
      throw new Error(`Transition invalide: statut=${this.state.status}, attendu=${expected}.`);
    }
  }

  private touch(): void {
    this.state.updatedAtMs = Date.now();
  }
}
