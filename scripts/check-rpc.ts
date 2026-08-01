import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import type { Address } from 'viem';
import { pancakeFactoryAbi } from '../src/abi/pancake-factory.abi.js';
import { config } from '../src/config/env.js';
import { chain } from '../src/config/chain.js';
import { publicClient, wsClient } from '../src/rpc/clients.js';
const MAX_HEAD_DELTA = 10n;
const DIAGNOSTIC_RANGE_BLOCKS = 10n;
const DEFAULT_CHECK_TIMEOUT_MS = 60_000;

interface RpcChainClient {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
}

interface RpcLogClient {
  getContractEvents(options: {
    address: Address;
    abi: readonly unknown[];
    eventName: string;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly unknown[]>;
}

interface RpcCheckClients {
  http: RpcChainClient & RpcLogClient;
  ws: RpcChainClient & { close?: () => void | Promise<void> };
}

export interface RpcCheckReport {
  network: string;
  expectedChainId: number;
  httpChainId: number;
  wsChainId: number;
  httpLatestBlock: string;
  wsLatestBlock: string;
  blockDelta: string;
  pairCreatedRangeFrom: string;
  pairCreatedRangeTo: string;
  pairCreatedEventCount: number;
  executionMode: string;
  riskPolicy: string;
  safetyProbeConfigured: boolean;
}

export function sanitizeRpcError(error: unknown): string {
  const raw = typeof error === 'string' ? error : error instanceof Error
    ? error.message
    : String(error);
  return raw
    .replace(/https?:\/\/[^\s'"]+/giu, '[REDACTED_RPC_URL]')
    .replace(/wss?:\/\/[^\s'"]+/giu, '[REDACTED_RPC_URL]');
}

export function calculatePairCreatedWindow(latestBlock: bigint): {
  fromBlock: bigint;
  toBlock: bigint;
} {
  const toBlock = latestBlock;
  const fromBlock = latestBlock >= DIAGNOSTIC_RANGE_BLOCKS - 1n
    ? latestBlock - (DIAGNOSTIC_RANGE_BLOCKS - 1n)
    : 0n;
  return { fromBlock, toBlock };
}

async function withTimeout<T>(
  action: () => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return Promise.race([
    action(),
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`${label}: timeout après ${ms} ms`)), ms);
    }),
  ]);
}

export async function runRpcChecks(
  clients: RpcCheckClients,
  options: {
    timeoutMs?: number;
    expectedChainId?: number;
    network?: string;
  } = {},
): Promise<RpcCheckReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const expectedChainId = options.expectedChainId ?? chain.id;
  const network = options.network ?? config.network;
  const requestTimeoutMs = timeoutMs <= 15_000 ? timeoutMs : 15_000;
  try {
    const [httpChainId, wsChainId] = await Promise.all([
      withTimeout(() => clients.http.getChainId(), requestTimeoutMs, 'Lecture chainId HTTP'),
      withTimeout(() => clients.ws.getChainId(), requestTimeoutMs, 'Lecture chainId WS'),
    ]);
    if (httpChainId !== expectedChainId) {
      throw new Error(
        `Le chainId HTTP ne correspond pas à ${network}.`,
      );
    }
    if (wsChainId !== expectedChainId) {
      throw new Error(
        `Le chainId WebSocket ne correspond pas à ${network}.`,
      );
    }

    const [httpLatestBlock, wsLatestBlock] = await Promise.all([
      withTimeout(() => clients.http.getBlockNumber(), requestTimeoutMs, 'Lecture bloc HTTP'),
      withTimeout(() => clients.ws.getBlockNumber(), requestTimeoutMs, 'Lecture bloc WS'),
    ]);
    const blockDelta = httpLatestBlock >= wsLatestBlock
      ? httpLatestBlock - wsLatestBlock
      : wsLatestBlock - httpLatestBlock;
    if (blockDelta > MAX_HEAD_DELTA) {
      throw new Error(
        `Écart anormal entre HTTP (${httpLatestBlock}) et WS (${wsLatestBlock}).`,
      );
    }

    const { fromBlock, toBlock } = calculatePairCreatedWindow(httpLatestBlock);
    const eventLogs = await withTimeout(
      () => clients.http.getContractEvents({
        address: config.factory,
        abi: pancakeFactoryAbi,
        eventName: 'PairCreated',
        fromBlock,
        toBlock,
      }),
      requestTimeoutMs,
      'getContractEvents',
    );

    return {
      network,
      expectedChainId,
      httpChainId,
      wsChainId,
      httpLatestBlock: httpLatestBlock.toString(),
      wsLatestBlock: wsLatestBlock.toString(),
      blockDelta: blockDelta.toString(),
      pairCreatedRangeFrom: fromBlock.toString(),
      pairCreatedRangeTo: toBlock.toString(),
      pairCreatedEventCount: eventLogs.length,
      executionMode: config.executionMode,
      riskPolicy: config.riskPolicy,
      safetyProbeConfigured: Boolean(config.safetyProbeAddress),
    };
  } finally {
    await withTimeout(
      async () => {
        if (!clients.ws.close) return;
        await clients.ws.close();
      },
      5_000,
      'Fermeture WebSocket',
    ).catch(() => {});
  }
}

async function main(): Promise<void> {
  const report = await withTimeout(
    () => runRpcChecks({ http: publicClient, ws: wsClient }),
    DEFAULT_CHECK_TIMEOUT_MS,
    'Diagnostic RPC complet',
  );
  console.log(JSON.stringify({
    network: report.network,
    expectedChainId: report.expectedChainId,
    rpc: {
      httpChainId: report.httpChainId,
      wsChainId: report.wsChainId,
      latestHttpBlock: report.httpLatestBlock,
      latestWsBlock: report.wsLatestBlock,
      blockDelta: report.blockDelta,
    },
    pairCreatedLogWindow: {
      fromBlock: report.pairCreatedRangeFrom,
      toBlock: report.pairCreatedRangeTo,
      count: report.pairCreatedEventCount,
    },
    executionMode: report.executionMode,
    riskPolicy: report.riskPolicy,
    safetyProbeConfigured: report.safetyProbeConfigured,
  }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await main();
    process.exit(0);
  } catch (error) {
    console.error(
      sanitizeRpcError(
        error instanceof Error ? error.message : String(error),
      ),
    );
    process.exit(1);
  }
}
