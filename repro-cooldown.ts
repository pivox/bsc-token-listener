import { createRpcClientPoolForTest } from './src/rpc/clients.js';
import { keccak256, type PublicClient } from 'viem';

type MethodResponse<T> = T | Error;
class MockPublicClient {
  private readonly blockNumberSequence: Array<MethodResponse<bigint>>;
  id: string;
  constructor(id:string, opts: { blockNumberSequence?: Array<MethodResponse<bigint>> } = {}) {
    this.id=id;
    this.blockNumberSequence = opts.blockNumberSequence ?? [];
  }
  getBlockNumber = async (): Promise<bigint> => {
    const now = Date.now();
    const first = this.blockNumberSequence.shift();
    console.log(this.id, 'getBlockNumber called at', now, 'remaining', this.blockNumberSequence.length, 'value', first);
    if (first instanceof Error) throw first;
    return first ?? 1n;
  };
  getContractEvents = async () => [] as any;
  getChainId = async () => 56;
  readContract = async () => ({} as any);
  simulateContract = async () => ({} as any);
  getBalance = async () => 0n;
  getTransactionReceipt = async () => ({}) as any;
  getTransaction = async () => ({}) as any;
  getCode = async () => '0x';
  getTransactionCount = async () => 0;
  getGasPrice = async () => 0n;
  waitForTransactionReceipt = async () => ({}) as any;
  watchContractEvent = undefined as never;
  close = async () => {};
  sendRawTransaction = async (input: { serializedTransaction: `0x${string}`}) => keccak256(input.serializedTransaction);
}
function providerDefinition(id: string, kind: 'HTTP'|'WEBSOCKET'|'TX', client: PublicClient){
  return { id, kind, url: `${id}.test`, client, maxLogBlockRange: 4 };
}

const source = new MockPublicClient('source', { blockNumberSequence: [new Error('timeout'), new Error('timeout'), 200n] });
const ws = new MockPublicClient('ws');
const tx = new MockPublicClient('tx');
const pool = createRpcClientPoolForTest({
  readProviders:[providerDefinition('http', 'HTTP', source as any)],
  wsProviders:[providerDefinition('ws', 'WEBSOCKET', ws as any)],
  txProviders:[providerDefinition('tx', 'TX', tx as any)],
});

const originalNow = Date.now;
let now = 0;
(Date as unknown as { now: () => number }).now = () => now;

const logSnapshots = async (label: string) => {
  console.log('\nCALL', label, 'at', Date.now());
  const snapshots = await pool.getProviderSnapshots();
  const read = snapshots.find((entry) => entry.id === 'http');
  const wsSnap = snapshots.find((entry) => entry.id === 'ws');
  const txSnap = snapshots.find((entry) => entry.id === 'tx');
  console.log(label, 'now', now, 'read', read?.status, read?.lagging, read?.lastError, read?.inCooldownUntilMs);
  console.log('ws', wsSnap?.status, wsSnap?.lastError);
  console.log('tx', txSnap?.status, txSnap?.lastError);
};

(async () => {
  await logSnapshots('first');
  now = 6_000;
  await logSnapshots('second');
  now = 25_000;
  await logSnapshots('third');
})().finally(() => {
  (Date as unknown as { now: () => number }).now = originalNow;
});
