import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { bscTestnet } from 'viem/chains';
import {
  simulateSafetyProbe,
  type SafetyProbeResult,
} from '../src/security/safety-probe.client.js';
import type { PairInfo } from '../src/types/domain.js';
import { sanitizeRpcText } from '../src/utils/sanitize.js';

const EXPECTED_CHAIN_ID = 97;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_DEADLINE_SECONDS = 120;
const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;
export const TESTNET_PROBE_CONFIRMATION = 'I_UNDERSTAND_READ_ONLY_TESTNET';

export interface TestnetProbeConfig {
  rpcUrl: string;
  probeAddress: Address;
  caller: Address;
  router: Address;
  token: Address;
  amountWei: bigint;
}

export interface TestnetProbeClient {
  getChainId(): Promise<number>;
  getBytecode(input: { address: Address }): Promise<Hex | undefined>;
  getBalance(input: { address: Address }): Promise<bigint>;
  getBlock(input: { blockTag: 'latest' }): Promise<{
    number: bigint | null;
    timestamp: bigint;
  }>;
}

export interface TestnetProbeReport {
  network: 'bsc-testnet';
  chainId: 97;
  blockNumber: string;
  executionMode: 'dry-run';
  readOnly: true;
  probeAddress: Address;
  caller: Address;
  router: Address;
  token: Address;
  amountWei: string;
  result: {
    buyTaxBps: number;
    sellTaxBps: number;
    roundTripLossBps: number;
    quotedTokens: string;
    receivedTokens: string;
    quotedNative: string;
    recoveredNative: string;
  };
}

type ProbeCall = (pair: PairInfo) => Promise<SafetyProbeResult>;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} est obligatoire.`);
  return value;
}

function address(env: NodeJS.ProcessEnv, name: string): Address {
  const value = required(env, name);
  if (!isAddress(value)) throw new Error(`${name} doit être une adresse EVM valide.`);
  return getAddress(value);
}

export function parseTestnetProbeConfig(env: NodeJS.ProcessEnv): TestnetProbeConfig {
  if (env.PRIVATE_KEY?.trim()) {
    throw new Error('PRIVATE_KEY est interdite pour ce scénario en lecture seule.');
  }
  if (env.BSC_NETWORK?.trim() !== 'testnet') {
    throw new Error('BSC_NETWORK doit valoir testnet.');
  }
  if (env.EXECUTION_MODE?.trim() !== 'dry-run') {
    throw new Error('EXECUTION_MODE doit valoir dry-run.');
  }
  if (env.CONFIRM_TESTNET_PROBE?.trim() !== TESTNET_PROBE_CONFIRMATION) {
    throw new Error('La confirmation explicite du smoke testnet est absente ou invalide.');
  }

  const rpcUrl = required(env, 'BSC_HTTP_RPC_URL');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rpcUrl);
  } catch {
    throw new Error('BSC_HTTP_RPC_URL doit être une URL HTTP ou HTTPS valide.');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('BSC_HTTP_RPC_URL doit être une URL HTTP ou HTTPS valide.');
  }

  let amountWei: bigint;
  try {
    amountWei = parseEther(env.RISK_PROBE_AMOUNT_BNB?.trim() || '0.005');
  } catch {
    throw new Error('RISK_PROBE_AMOUNT_BNB doit être un montant BNB valide.');
  }
  if (amountWei <= 0n) {
    throw new Error('RISK_PROBE_AMOUNT_BNB doit être strictement positif.');
  }

  return {
    rpcUrl,
    probeAddress: address(env, 'SAFETY_PROBE_ADDRESS'),
    caller: address(env, 'RISK_PROBE_CALLER'),
    router: address(env, 'PANCAKE_ROUTER_ADDRESS'),
    token: address(env, 'TESTNET_PROBE_TOKEN_ADDRESS'),
    amountWei,
  };
}

function pairFor(config: TestnetProbeConfig): PairInfo {
  return {
    factory: '0x0000000000000000000000000000000000000000',
    router: config.router,
    wbnb: '0x0000000000000000000000000000000000000000',
    pair: '0x0000000000000000000000000000000000000000',
    token: config.token,
    token0: '0x0000000000000000000000000000000000000000',
    token1: '0x0000000000000000000000000000000000000000',
    createdBlock: 0n,
    blockHash: ZERO_HASH,
    createdTransactionHash: ZERO_HASH,
    createdLogIndex: 0,
    discoveredAtMs: 0,
  };
}

export async function runTestnetSafetyProbe(
  client: TestnetProbeClient,
  config: TestnetProbeConfig,
  probeCall?: ProbeCall,
): Promise<TestnetProbeReport> {
  const chainId = await client.getChainId();
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error('Le endpoint RPC ne correspond pas au chain ID 97 de BSC testnet.');
  }

  const [probeCode, routerCode, tokenCode] = await Promise.all([
    client.getBytecode({ address: config.probeAddress }),
    client.getBytecode({ address: config.router }),
    client.getBytecode({ address: config.token }),
  ]);
  for (const [label, code] of [
    ['probe', probeCode],
    ['routeur', routerCode],
    ['token', tokenCode],
  ] as const) {
    if (!code || code === '0x') throw new Error(`Le ${label} ne possède aucun bytecode.`);
  }

  const balance = await client.getBalance({ address: config.caller });
  if (balance < config.amountWei) {
    throw new Error('Le solde du compte appelant est insuffisant pour simuler msg.value.');
  }
  const block = await client.getBlock({ blockTag: 'latest' });
  if (block.number === null) throw new Error('Le dernier bloc testnet est incomplet.');

  const pair = pairFor(config);
  const executeProbe = probeCall ?? ((input: PairInfo) => simulateSafetyProbe(
    client as PublicClient,
    {
      address: config.probeAddress,
      caller: config.caller,
      amountWei: config.amountWei,
      deadlineSeconds: DEFAULT_DEADLINE_SECONDS,
      nowMs: () => Number(block.timestamp) * 1_000,
    },
    input,
  ));
  const result = await executeProbe(pair);

  return {
    network: 'bsc-testnet',
    chainId: EXPECTED_CHAIN_ID,
    blockNumber: block.number.toString(),
    executionMode: 'dry-run',
    readOnly: true,
    probeAddress: config.probeAddress,
    caller: config.caller,
    router: config.router,
    token: config.token,
    amountWei: config.amountWei.toString(),
    result: {
      buyTaxBps: result.buyTaxBps,
      sellTaxBps: result.sellTaxBps,
      roundTripLossBps: result.roundTripLossBps,
      quotedTokens: result.quotedTokens.toString(),
      receivedTokens: result.receivedTokens.toString(),
      quotedNative: result.quotedNative.toString(),
      recoveredNative: result.recoveredNative.toString(),
    },
  };
}

export function sanitizeTestnetProbeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeRpcText(message);
}

async function withTimeout<T>(action: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      action(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Smoke testnet: timeout après ${timeoutMs} ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const config = parseTestnetProbeConfig(process.env);
  const client = createPublicClient({
    chain: bscTestnet,
    transport: http(config.rpcUrl, { timeout: 15_000 }),
  });
  const report = await withTimeout(
    () => runTestnetSafetyProbe(client, config),
    DEFAULT_TIMEOUT_MS,
  );
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await main();
  } catch (error) {
    console.error(sanitizeTestnetProbeError(error));
    process.exitCode = 1;
  }
}
