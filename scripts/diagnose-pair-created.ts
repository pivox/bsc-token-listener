import { fileURLToPath } from 'node:url';
import type { Address, Hash } from 'viem';
import { pancakeFactoryAbi } from '../src/abi/pancake-factory.abi.js';
import { config } from '../src/config/env.js';
import { publicClient } from '../src/rpc/clients.js';
import 'dotenv/config';

interface PairCreatedLog {
  args: {
    token0?: Address;
    token1?: Address;
    pair?: Address;
  };
  blockNumber: bigint | null;
  transactionHash: Hash | null;
  logIndex: number | null;
}

interface DiagnosticPairCreatedReport {
  network: string;
  factory: string;
  wbnb: string;
  latestBlock: string;
  fromBlock: string;
  toBlock: string;
  scannedBlocks: string;
  totalPairCreated: number;
  decodedPairCreated: number;
  directWbnbPairs: number;
  nonWbnbPairs: number;
  incompleteLogs: number;
  diagnosis: string;
  samples: Array<{
    blockNumber: string;
    transactionHash: Hash;
    pair: Address;
    token0: Address;
    token1: Address;
    includesWbnb: boolean;
  }>;
}

function sanitizeDiagnosticError(error: unknown): string {
  const raw = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : String(error);
  return raw
    .replace(/https?:\/\/[^\s'"]+/giu, '[REDACTED_RPC_URL]')
    .replace(/wss?:\/\/[^\s'"]+/giu, '[REDACTED_RPC_URL]');
}

function optionalBlock(name: string): bigint | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${name} doit être un numéro de bloc positif.`);
  }
  return BigInt(value);
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]?.trim() ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} doit être un entier strictement positif.`);
  }
  return value;
}

export function parseDiagnosticPairChunkSize(): number {
  const override = process.env.PAIR_DIAGNOSTIC_CHUNK_SIZE;
  const maxChunk = config.rpcMaxLogBlockRange;
  if (override === undefined || override.trim().length === 0) return maxChunk;
  const parsed = Number(override);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('PAIR_DIAGNOSTIC_CHUNK_SIZE doit être un entier strictement positif.');
  }
  if (parsed > maxChunk) {
    throw new Error(
      `PAIR_DIAGNOSTIC_CHUNK_SIZE=${parsed} dépasse RPC_MAX_LOG_BLOCK_RANGE=${maxChunk}.`,
    );
  }
  return parsed;
}

async function runDiagnosticPairCreated(): Promise<DiagnosticPairCreatedReport> {
  const latest = await publicClient.getBlockNumber();
  const explicitFrom = optionalBlock('PAIR_DIAGNOSTIC_FROM_BLOCK');
  const explicitTo = optionalBlock('PAIR_DIAGNOSTIC_TO_BLOCK');
  const blockWindow = BigInt(positiveInteger('PAIR_DIAGNOSTIC_BLOCKS', 30_000));
  const chunkSize = BigInt(parseDiagnosticPairChunkSize());

  const toBlock = explicitTo ?? latest;
  const fromBlock = explicitFrom
    ?? (toBlock >= blockWindow - 1n ? toBlock - blockWindow + 1n : 0n);
  if (fromBlock > toBlock) {
    throw new Error('PAIR_DIAGNOSTIC_FROM_BLOCK doit être inférieur ou égal au bloc final.');
  }

  let totalPairCreated = 0;
  let directWbnbPairs = 0;
  let incompleteLogs = 0;
  const samples: DiagnosticPairCreatedReport['samples'] = [];

  for (let cursor = fromBlock; cursor <= toBlock; cursor += chunkSize) {
    const chunkEnd = cursor + chunkSize - 1n > toBlock
      ? toBlock
      : cursor + chunkSize - 1n;
    const logs = await publicClient.getContractEvents({
      address: config.factory,
      abi: pancakeFactoryAbi,
      eventName: 'PairCreated',
      fromBlock: cursor,
      toBlock: chunkEnd,
    }) as PairCreatedLog[];

    totalPairCreated += logs.length;
    for (const log of logs) {
      const { token0, token1, pair } = log.args;
      if (!token0 || !token1 || !pair || log.blockNumber === null || !log.transactionHash) {
        incompleteLogs += 1;
        continue;
      }
      const includesWbnb = token0.toLowerCase() === config.wbnb.toLowerCase()
        || token1.toLowerCase() === config.wbnb.toLowerCase();
      if (includesWbnb) directWbnbPairs += 1;
      if (samples.length < 20) {
        samples.push({
          blockNumber: log.blockNumber.toString(),
          transactionHash: log.transactionHash,
          pair,
          token0,
          token1,
          includesWbnb,
        });
      }
    }
  }

  const decodedPairCreated = totalPairCreated - incompleteLogs;
  const nonWbnbPairs = decodedPairCreated - directWbnbPairs;
  const diagnosis = totalPairCreated === 0
    ? 'Aucun PairCreated retourné: vérifier le provider RPC ou confirmer l’absence réelle d’événement avec un second provider.'
    : incompleteLogs === totalPairCreated
      ? 'Tous les événements PairCreated sont incomplets: le décodage ABI est défectueux; ne pas conclure sur le filtre WBNB.'
      : directWbnbPairs === 0
        ? 'Des paires V2 ont été décodées, mais aucune paire directe Token/WBNB dans cette plage.'
        : 'Des paires Token/WBNB existent dans la plage: si les tables sont vides, le traitement après PairCreated doit être corrigé.';

  return {
    network: config.network,
    factory: config.factory,
    wbnb: config.wbnb,
    latestBlock: latest.toString(),
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    scannedBlocks: (toBlock - fromBlock + 1n).toString(),
    totalPairCreated,
    decodedPairCreated,
    directWbnbPairs,
    nonWbnbPairs,
    incompleteLogs,
    diagnosis,
    samples,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runDiagnosticPairCreated()
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
    })
    .catch((error: unknown) => {
      console.error(sanitizeDiagnosticError(
        error instanceof Error ? error.message : String(error),
      ));
      process.exitCode = 1;
    });
}
