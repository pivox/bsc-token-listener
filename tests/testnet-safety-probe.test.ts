import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { Address } from 'viem';
import {
  TESTNET_PROBE_CONFIRMATION,
  parseTestnetProbeConfig,
  runTestnetSafetyProbe,
  sanitizeTestnetProbeError,
  type TestnetProbeClient,
} from '../scripts/check-testnet-safety-probe.js';

const probeAddress = '0x0000000000000000000000000000000000000011';
const caller = '0x0000000000000000000000000000000000000022';
const router = '0x0000000000000000000000000000000000000033';
const token = '0x0000000000000000000000000000000000000044';

function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    BSC_NETWORK: 'testnet',
    EXECUTION_MODE: 'dry-run',
    BSC_HTTP_RPC_URL: 'https://rpc.example.test/secret-path',
    SAFETY_PROBE_ADDRESS: probeAddress,
    RISK_PROBE_CALLER: caller,
    PANCAKE_ROUTER_ADDRESS: router,
    TESTNET_PROBE_TOKEN_ADDRESS: token,
    RISK_PROBE_AMOUNT_BNB: '0.005',
    CONFIRM_TESTNET_PROBE: TESTNET_PROBE_CONFIRMATION,
    ...overrides,
  };
}

function client(overrides: Partial<TestnetProbeClient> = {}): TestnetProbeClient {
  return {
    getChainId: async () => 97,
    getBytecode: async () => '0x6000',
    getBalance: async () => 10_000_000_000_000_000n,
    getBlock: async () => ({ number: 42n, timestamp: 1_800_000_000n }),
    ...overrides,
  };
}

test('le parseur accepte uniquement une configuration testnet dry-run explicite', () => {
  const config = parseTestnetProbeConfig(validEnv());

  assert.equal(config.rpcUrl, 'https://rpc.example.test/secret-path');
  assert.equal(config.probeAddress, probeAddress as Address);
  assert.equal(config.caller, caller as Address);
  assert.equal(config.router, router as Address);
  assert.equal(config.token, token as Address);
  assert.equal(config.amountWei, 5_000_000_000_000_000n);
});

test('le parseur refuse toute absence de confirmation, réseau testnet ou dry-run', () => {
  assert.throws(
    () => parseTestnetProbeConfig(validEnv({ CONFIRM_TESTNET_PROBE: '' })),
    /confirmation explicite/i,
  );
  assert.throws(
    () => parseTestnetProbeConfig(validEnv({ BSC_NETWORK: 'mainnet' })),
    /testnet/i,
  );
  assert.throws(
    () => parseTestnetProbeConfig(validEnv({ EXECUTION_MODE: 'live' })),
    /dry-run/i,
  );
});

test('le parseur refuse une clé privée avant tout appel RPC', () => {
  assert.throws(
    () => parseTestnetProbeConfig(validEnv({ PRIVATE_KEY: '0xnot-a-real-key' })),
    /PRIVATE_KEY.*interdite/i,
  );
});

test('le parseur refuse les URL et adresses invalides sans exposer l’URL', () => {
  assert.throws(
    () => parseTestnetProbeConfig(validEnv({ BSC_HTTP_RPC_URL: 'file:///tmp/rpc' })),
    /HTTP ou HTTPS/i,
  );
  assert.throws(
    () => parseTestnetProbeConfig(validEnv({ SAFETY_PROBE_ADDRESS: 'invalid' })),
    /SAFETY_PROBE_ADDRESS/i,
  );
});

test('le runner refuse un chain ID différent avant tout autre accès', async () => {
  const calls: string[] = [];
  const rpc = client({
    getChainId: async () => {
      calls.push('chainId');
      return 56;
    },
    getBytecode: async () => {
      calls.push('bytecode');
      return '0x6000';
    },
  });

  await assert.rejects(
    () => runTestnetSafetyProbe(rpc, parseTestnetProbeConfig(validEnv()), async () => {
      calls.push('probe');
      throw new Error('ne doit pas être appelé');
    }),
    /chain ID 97/i,
  );
  assert.deepEqual(calls, ['chainId']);
});

test('le runner vérifie bytecode et solde avant la simulation', async () => {
  let probeCalls = 0;
  await assert.rejects(
    () => runTestnetSafetyProbe(
      client({ getBytecode: async ({ address }) => address === token ? '0x' : '0x6000' }),
      parseTestnetProbeConfig(validEnv()),
      async () => {
        probeCalls += 1;
        throw new Error('ne doit pas être appelé');
      },
    ),
    /token.*bytecode/i,
  );
  assert.equal(probeCalls, 0);

  await assert.rejects(
    () => runTestnetSafetyProbe(
      client({ getBalance: async () => 1n }),
      parseTestnetProbeConfig(validEnv()),
      async () => {
        probeCalls += 1;
        throw new Error('ne doit pas être appelé');
      },
    ),
    /solde.*insuffisant/i,
  );
  assert.equal(probeCalls, 0);
});

test('le runner retourne un rapport JSON sans URL RPC', async () => {
  const report = await runTestnetSafetyProbe(
    client(),
    parseTestnetProbeConfig(validEnv()),
    async () => ({
      buyTaxBps: 100,
      sellTaxBps: 200,
      roundTripLossBps: 298,
      quotedTokens: 10_000n,
      receivedTokens: 9_900n,
      quotedNative: 9_900n,
      recoveredNative: 9_702n,
    }),
  );

  assert.deepEqual(report, {
    network: 'bsc-testnet',
    chainId: 97,
    blockNumber: '42',
    executionMode: 'dry-run',
    readOnly: true,
    probeAddress,
    caller,
    router,
    token,
    amountWei: '5000000000000000',
    result: {
      buyTaxBps: 100,
      sellTaxBps: 200,
      roundTripLossBps: 298,
      quotedTokens: '10000',
      receivedTokens: '9900',
      quotedNative: '9900',
      recoveredNative: '9702',
    },
  });
  assert.doesNotThrow(() => JSON.stringify(report));
  assert.doesNotMatch(JSON.stringify(report), /rpc\.example\.test|secret-path/i);
});

test('les erreurs RPC affichées ne révèlent aucune URL', () => {
  const message = sanitizeTestnetProbeError(
    new Error('échec https://user:token@rpc.example.test/secret-path puis wss://backup.example/ws'),
  );

  assert.equal(
    message,
    'échec [REDACTED_RPC_URL] puis [REDACTED_RPC_URL]',
  );
});

test('le scénario testnet ne contient aucune primitive de signature ou transaction et reste hors CI', async () => {
  const [scriptSource, probeSource, workflow, packageJson] = await Promise.all([
    readFile('scripts/check-testnet-safety-probe.ts', 'utf8'),
    readFile('src/security/safety-probe.client.ts', 'utf8'),
    readFile('.github/workflows/ci.yml', 'utf8'),
    readFile('package.json', 'utf8'),
  ]);

  assert.doesNotMatch(
    `${scriptSource}\n${probeSource}`,
    /createWalletClient|privateKeyToAccount|sendTransaction|writeContract|deployContract|signTransaction|eth_send|walletClient/,
  );
  assert.match(probeSource, /simulateContract/);
  assert.doesNotMatch(workflow, /test:testnet|check-testnet-safety-probe/);
  assert.equal(JSON.parse(packageJson).scripts['test:testnet'], 'tsx scripts/check-testnet-safety-probe.ts');
});
