import { isAddress, isHash } from 'viem';
import type {
  ChainCursor,
  EntryExecution,
  ExitExecution,
  PairInfo,
  SwapEvent,
  TokenMetadata,
  TokenSession,
} from './domain.js';

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null;
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function bigint(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= 0n;
}

function optional(
  value: Record<string, unknown>,
  key: string,
  predicate: (candidate: unknown) => boolean,
): boolean {
  return value[key] === undefined || predicate(value[key]);
}

function chainCursor(value: unknown): value is ChainCursor {
  const candidate = object(value);
  return candidate !== null
    && bigint(candidate.blockNumber)
    && integer(candidate.transactionIndex)
    && integer(candidate.logIndex);
}

function pairInfo(value: unknown): value is PairInfo {
  const candidate = object(value);
  if (!candidate) return false;
  if (
    typeof candidate.factory !== 'string' || !isAddress(candidate.factory)
    || typeof candidate.router !== 'string' || !isAddress(candidate.router)
    || typeof candidate.wbnb !== 'string' || !isAddress(candidate.wbnb)
    || typeof candidate.pair !== 'string' || !isAddress(candidate.pair)
    || typeof candidate.token !== 'string' || !isAddress(candidate.token)
    || typeof candidate.token0 !== 'string' || !isAddress(candidate.token0)
    || typeof candidate.token1 !== 'string' || !isAddress(candidate.token1)
    || !bigint(candidate.createdBlock)
    || typeof candidate.blockHash !== 'string' || !isHash(candidate.blockHash)
    || typeof candidate.createdTransactionHash !== 'string'
    || !isHash(candidate.createdTransactionHash)
    || !integer(candidate.createdLogIndex)
    || !integer(candidate.discoveredAtMs)
  ) return false;
  const assets = new Set([
    candidate.token0.toLowerCase(),
    candidate.token1.toLowerCase(),
  ]);
  return assets.size === 2
    && assets.has(candidate.token.toLowerCase())
    && assets.has(candidate.wbnb.toLowerCase());
}

function metadata(value: unknown, token: string): value is TokenMetadata {
  const candidate = object(value);
  return candidate !== null
    && typeof candidate.address === 'string'
    && isAddress(candidate.address)
    && candidate.address.toLowerCase() === token.toLowerCase()
    && (candidate.name === null || typeof candidate.name === 'string')
    && (candidate.symbol === null || typeof candidate.symbol === 'string')
    && integer(candidate.decimals)
    && candidate.decimals <= 255
    && bigint(candidate.totalSupply)
    && integer(candidate.codeSizeBytes);
}

function swapEvent(value: unknown, pairAddress: string): value is SwapEvent {
  const candidate = object(value);
  return candidate !== null
    && typeof candidate.id === 'string'
    && candidate.id.length > 0
    && typeof candidate.pair === 'string'
    && isAddress(candidate.pair)
    && candidate.pair.toLowerCase() === pairAddress.toLowerCase()
    && typeof candidate.transactionHash === 'string'
    && isHash(candidate.transactionHash)
    && typeof candidate.blockHash === 'string'
    && isHash(candidate.blockHash)
    && (
      candidate.kind === 'BUY'
      || candidate.kind === 'SELL'
      || candidate.kind === 'OTHER'
    )
    && typeof candidate.sender === 'string'
    && isAddress(candidate.sender)
    && typeof candidate.recipient === 'string'
    && isAddress(candidate.recipient)
    && bigint(candidate.amount0In)
    && bigint(candidate.amount1In)
    && bigint(candidate.amount0Out)
    && bigint(candidate.amount1Out)
    && bigint(candidate.amountWbnb)
    && bigint(candidate.amountToken)
    && chainCursor(candidate.cursor)
    && integer(candidate.observedAtMs);
}

function entryExecution(value: unknown): value is EntryExecution {
  const candidate = object(value);
  return candidate !== null
    && (candidate.mode === 'dry-run' || candidate.mode === 'live')
    && optional(candidate, 'tradeId', (item) => typeof item === 'string' && item.length > 0)
    && bigint(candidate.amountInWei)
    && optional(candidate, 'quotedAmountOutToken', bigint)
    && bigint(candidate.amountOutToken)
    && optional(candidate, 'gasCostWei', bigint)
    && integer(candidate.confirmedAtMs)
    && chainCursor(candidate.cursor)
    && optional(candidate, 'transactionHash', (item) =>
      typeof item === 'string' && isHash(item)
    );
}

function exitExecution(value: unknown): value is ExitExecution {
  const candidate = object(value);
  return candidate !== null
    && (candidate.mode === 'dry-run' || candidate.mode === 'live')
    && optional(candidate, 'tradeId', (item) => typeof item === 'string' && item.length > 0)
    && optional(candidate, 'entryTradeId', (item) => typeof item === 'string' && item.length > 0)
    && bigint(candidate.amountInToken)
    && optional(candidate, 'quotedAmountOutWei', bigint)
    && bigint(candidate.amountOutWei)
    && optional(candidate, 'gasCostWei', bigint)
    && integer(candidate.confirmedAtMs)
    && optional(candidate, 'transactionHash', (item) =>
      typeof item === 'string' && isHash(item)
    );
}

const SESSION_STATUSES = new Set([
  'WAITING_FIRST_BUY',
  'RISK_CHECKING',
  'BUY_PENDING',
  'HOLDING',
  'SELL_PENDING',
  'CLOSED',
  'REJECTED',
  'EXPIRED',
  'MANUAL_REVIEW',
]);

export function isTokenSession(value: unknown): value is TokenSession {
  const candidate = object(value);
  if (!candidate || !pairInfo(candidate.pair)) return false;
  const pair = candidate.pair.pair;
  return metadata(candidate.metadata, candidate.pair.token)
    && typeof candidate.status === 'string'
    && SESSION_STATUSES.has(candidate.status)
    && optional(candidate, 'firstBuy', (item) => swapEvent(item, pair))
    && optional(candidate, 'entryObservationBuys', (item) =>
      Array.isArray(item) && item.every((event) => swapEvent(event, pair))
    )
    && optional(candidate, 'entry', entryExecution)
    && optional(candidate, 'exit', exitExecution)
    && optional(candidate, 'pendingExecutionSourceEventId', (item) =>
      typeof item === 'string' && item.length > 0
    )
    && optional(candidate, 'unreconciledExecution', (item) => {
      const reference = object(item);
      return reference !== null
        && typeof reference.tradeId === 'string'
        && reference.tradeId.length > 0
        && (
          reference.step === 'BUY'
          || reference.step === 'APPROVE'
          || reference.step === 'SELL'
        )
        && (reference.outcome === 'CONFIRMED' || reference.outcome === 'UNKNOWN')
        && typeof reference.transactionHash === 'string'
        && isHash(reference.transactionHash)
        && integer(reference.recordedAtMs);
    })
    && optional(candidate, 'recovery', (item) => {
      const diagnostic = object(item);
      return diagnostic !== null
        && integer(diagnostic.attempts)
        && typeof diagnostic.lastAction === 'string'
        && typeof diagnostic.lastReason === 'string'
        && integer(diagnostic.lastAttemptAtMs);
    })
    && integer(candidate.subsequentBuyCount)
    && integer(candidate.targetBuysAfterEntry)
    && Array.isArray(candidate.countedBuyTransactionHashes)
    && candidate.countedBuyTransactionHashes.every((item) =>
      typeof item === 'string' && isHash(item)
    )
    && optional(candidate, 'lastProcessedCursor', chainCursor)
    && optional(candidate, 'rejectionReason', (item) => typeof item === 'string')
    && optional(candidate, 'riskReportId', (item) => typeof item === 'string' && item.length > 0)
    && integer(candidate.sellAttempts)
    && integer(candidate.createdAtMs)
    && integer(candidate.updatedAtMs);
}
