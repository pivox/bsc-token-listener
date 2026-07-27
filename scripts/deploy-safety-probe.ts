import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc, bscTestnet } from 'viem/chains';
import solc from 'solc';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variable manquante: ${name}`);
  return value;
}

const network = process.env.BSC_NETWORK?.trim() ?? 'testnet';
if (network !== 'mainnet' && network !== 'testnet') {
  throw new Error('BSC_NETWORK doit valoir mainnet ou testnet.');
}
const confirmation = network === 'mainnet'
  ? 'I_UNDERSTAND_MAINNET'
  : 'I_UNDERSTAND_TESTNET';
if (process.env.CONFIRM_PROBE_DEPLOYMENT?.trim() !== confirmation) {
  throw new Error(`Déploiement bloqué: définir CONFIRM_PROBE_DEPLOYMENT=${confirmation}.`);
}

const rawKey = required('PRIVATE_KEY');
const privateKey = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as Hex;
if (!/^0x[0-9a-fA-F]{64}$/u.test(privateKey)) throw new Error('PRIVATE_KEY invalide.');

const source = await readFile('contracts/SafetyProbe.sol', 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'SafetyProbe.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};
const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
  errors?: Array<{ severity: string; formattedMessage: string }>;
  contracts?: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>>;
};
const errors = output.errors?.filter((error) => error.severity === 'error') ?? [];
if (errors.length > 0) throw new Error(errors.map((error) => error.formattedMessage).join('\n'));
const compiled = output.contracts?.['SafetyProbe.sol']?.['SafetyProbe'];
if (!compiled) throw new Error('Compilation SafetyProbe introuvable.');

const chain = network === 'mainnet' ? bsc : bscTestnet;
const transport = http(required('BSC_HTTP_RPC_URL'));
const account = privateKeyToAccount(privateKey);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ chain, transport, account });
const hash = await walletClient.deployContract({
  abi: compiled.abi,
  bytecode: `0x${compiled.evm.bytecode.object}`,
  account,
});
const receipt = await publicClient.waitForTransactionReceipt({
  hash,
  confirmations: 1,
  timeout: 120_000,
});
if (receipt.status !== 'success' || !receipt.contractAddress) {
  throw new Error(`Déploiement échoué: ${hash}`);
}
console.log(`SAFETY_PROBE_ADDRESS=${receipt.contractAddress}`);
console.log(`RISK_PROBE_CALLER=${account.address}`);
