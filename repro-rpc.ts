import { createRpcClientPoolForTest } from './src/rpc/clients.js';
import { keccak256, type PublicClient } from 'viem';

interface ContractEventsInput { address: `0x${string}`; eventName: string; fromBlock: bigint; toBlock: bigint; }
type MethodResponse<T> = T | Error;
class MockPublicClient {
  private readonly contractEventsSequence: Array<(input: ContractEventsInput) => MethodResponse<readonly unknown[]>>;
  readonly contractEventsCalls: ContractEventsInput[] = [];
  constructor(opts: { contractEventsSequence?: Array<(input: ContractEventsInput) => MethodResponse<readonly unknown[]>> } = {}) {
    this.contractEventsSequence = opts.contractEventsSequence ?? [];
  }
  private nextContractEvents(input: ContractEventsInput): MethodResponse<readonly unknown[]> {
    const first = this.contractEventsSequence.shift();
    if (first) return first(input);
    return [];
  }
  getContractEvents = async (input: ContractEventsInput): Promise<readonly unknown[]> => {
    this.contractEventsCalls.push(input);
    const response = this.nextContractEvents(input);
    if (response instanceof Error) throw response;
    return response;
  };

  getChainId = async () => 56;
  getBlockNumber = async () => 1n;
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
  sendRawTransaction = async (_x: {serializedTransaction: `0x${string}`}) => keccak256(_x.serializedTransaction);
}

function providerDefinition(id: string, kind: 'HTTP'|'WEBSOCKET'|'TX', client: PublicClient) {
  return { id, kind, url: `${id}.test`, client, maxLogBlockRange: 2 };
}

const ADDRESS = `0x${'a'.repeat(40)}` as const;
const primary = new MockPublicClient({
  contractEventsSequence: [() => [{ id: 'p-1' }], () => new Error('network failure in chunk')],
});
const secondary = new MockPublicClient({
  contractEventsSequence: [() => { console.log('secondary call1'); return new Error('secondary temporarily unavailable'); }, () => [{ id: 's-1' }, { id: 's-2' }], () => [{ id: 's-3' }, { id: 's-4' }]],
});
const ws = new MockPublicClient({});
const tx = new MockPublicClient({});
const pool = createRpcClientPoolForTest({
  readProviders: [providerDefinition('main', 'HTTP', primary as any), providerDefinition('fallback', 'HTTP', secondary as any)],
  wsProviders: [providerDefinition('ws', 'WEBSOCKET', ws as any)],
  txProviders: [providerDefinition('tx', 'TX', tx as any)],
});

(async () => {
  let checkpoint = 1n;
  const readChunk = async () => {
    try {
      await pool.getPublicClient().getContractEvents({ address: ADDRESS, abi: [], eventName: 'PairCreated', fromBlock: checkpoint, toBlock: 4n });
      checkpoint = 5n;
      return true;
    } catch (e) {
      console.log('error', String((e as Error).message));
      return false;
    }
  };

  for (let i = 1; i <= 2; i++) {
    const ok = await readChunk();
    console.log('attempt', i, ok, 'checkpoint', checkpoint);
    console.log('primary calls', primary.contractEventsCalls.map((c) => `${c.fromBlock}-${c.toBlock}`));
    console.log('secondary calls', secondary.contractEventsCalls.map((c) => `${c.fromBlock}-${c.toBlock}`));
  }
})();
