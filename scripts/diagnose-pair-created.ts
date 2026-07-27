import type { Address, Hash } from 'viem';
import { pancakeFactoryAbi } from '../src/abi/pancake-factory.abi.js';
import { config } from '../src/config/env.js';
import { publicClient } from '../src/rpc/clients.js';

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

function optionalBlock(name: string): bigint | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
  if (!/^\d+$/u.test(value)) throw new Error(`${name} doit être un numéro de bloc positif.`);
  return BigInt(value);
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]?.trim() ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} doit être un entier strictement positif.`);
  }
  return value;
}

const latest = await publicClient.getBlockNumber();
const explicitFrom = optionalBlock('PAIR_DIAGNOSTIC_FROM_BLOCK');
const explicitTo = optionalBlock('PAIR_DIAGNOSTIC_TO_BLOCK');
const blockWindow = BigInt(positiveInteger('PAIR_DIAGNOSTIC_BLOCKS', 30_000));
const chunkSize = BigInt(positiveInteger('PAIR_DIAGNOSTIC_CHUNK_SIZE', 1_500));

const toBlock = explicitTo ?? latest;
const fromBlock = explicitFrom ?? (toBlock >= blockWindow - 1n ? toBlock - blockWindow + 1n : 0n);
if (fromBlock > toBlock) throw new Error('PAIR_DIAGNOSTIC_FROM_BLOCK doit être inférieur ou égal au bloc final.');

let totalPairCreated = 0;
let directWbnbPairs = 0;
let incompleteLogs = 0;
const samples: Array<{
  blockNumber: string;
  transactionHash: Hash;
  pair: Address;
  token0: Address;
  token1: Address;
  includesWbnb: boolean;
}> = [];

for (let cursor = fromBlock; cursor <= toBlock; cursor += chunkSize) {
  const chunkEnd = cursor + chunkSize - 1n > toBlock ? toBlock : cursor + chunkSize - 1n;
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

const diagnosis = totalPairCreated === 0
  ? 'Aucun PairCreated retourné: vérifier le provider RPC ou confirmer l’absence réelle d’événement avec un second provider.'
  : directWbnbPairs === 0
    ? 'Des paires V2 ont été créées, mais aucune paire directe Token/WBNB: les tables vides sont cohérentes avec le filtre actuel.'
    : 'Des paires Token/WBNB existent dans la plage: si les tables sont vides, le traitement après PairCreated doit être corrigé.';

console.log(JSON.stringify({
  network: config.network,
  factory: config.factory,
  wbnb: config.wbnb,
  latestBlock: latest.toString(),
  fromBlock: fromBlock.toString(),
  toBlock: toBlock.toString(),
  scannedBlocks: (toBlock - fromBlock + 1n).toString(),
  totalPairCreated,
  directWbnbPairs,
  nonWbnbPairs: totalPairCreated - directWbnbPairs,
  incompleteLogs,
  diagnosis,
  samples,
}, null, 2));
