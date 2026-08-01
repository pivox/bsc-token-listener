import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { network } from 'hardhat';
import solc from 'solc';
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  getAddress,
  isAddress,
  zeroAddress,
  type Abi,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { SafetyProbeService } from '../../src/security/safety-probe.service.js';
import type { PairInfo } from '../../src/types/domain.js';

interface CompiledContract {
  abi: Abi;
  evm: { bytecode: { object: string } };
}

interface CompilerOutput {
  contracts?: Record<string, Record<string, CompiledContract>>;
  errors?: Array<{ severity: string; formattedMessage: string }>;
}

export interface LocalProbeScenario {
  service: SafetyProbeService;
  pair: PairInfo;
  close(): Promise<void>;
}

const fixtureDirectory = fileURLToPath(
  new URL('../../contracts/fixtures/', import.meta.url),
);
const safetyProbePath = fileURLToPath(
  new URL('../../contracts/SafetyProbe.sol', import.meta.url),
);

async function compileContracts(): Promise<Map<string, CompiledContract>> {
  const fixtureFiles = (await readdir(fixtureDirectory))
    .filter((file) => file.endsWith('.sol'))
    .sort();
  const sources: Record<string, { content: string }> = {
    'SafetyProbe.sol': { content: await readFile(safetyProbePath, 'utf8') },
  };
  for (const file of fixtureFiles) {
    sources[file] = {
      content: await readFile(`${fixtureDirectory}/${file}`, 'utf8'),
    };
  }

  const output = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  }))) as CompilerOutput;
  const errors = output.errors?.filter(({ severity }) => severity === 'error') ?? [];
  if (errors.length > 0) {
    throw new Error(errors.map(({ formattedMessage }) => formattedMessage).join('\n'));
  }

  const contracts = new Map<string, CompiledContract>();
  for (const sourceContracts of Object.values(output.contracts ?? {})) {
    for (const [name, contract] of Object.entries(sourceContracts)) {
      if (contract.evm.bytecode.object.length > 0) contracts.set(name, contract);
    }
  }
  return contracts;
}

export async function deploySafetyProbeScenario(
  tokenContract: string,
  tokenArgs: readonly unknown[] = [],
): Promise<LocalProbeScenario> {
  const connection = await network.create({ network: 'local', chainType: 'l1' });
  try {
    const transport = custom({
      request: async ({ method, params }) => connection.provider.request({
        method,
        params: params ?? [],
      }),
    });
    const bootstrapClient = createPublicClient({ transport });
    const chainId = await bootstrapClient.getChainId();
    const chain = defineChain({
      id: chainId,
      name: 'Embedded Hardhat EDR',
      nativeCurrency: { name: 'Native', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [] } },
    });
    const publicClient = createPublicClient({ chain, transport });
    const accounts = await connection.provider.request({ method: 'eth_accounts' });
    const firstAccount = Array.isArray(accounts) ? accounts[0] : undefined;
    if (typeof firstAccount !== 'string' || !isAddress(firstAccount)) {
      throw new Error('Aucun compte local EVM disponible.');
    }
    const caller = getAddress(firstAccount);
    const walletClient = createWalletClient({ account: caller, chain, transport });
    const contracts = await compileContracts();

    const deploy = async (
      contractName: string,
      args: readonly unknown[] = [],
    ): Promise<Address> => {
      const compiled = contracts.get(contractName);
      if (!compiled) throw new Error(`Contrat compilé introuvable: ${contractName}.`);
      const hash = await walletClient.deployContract({
        abi: compiled.abi,
        bytecode: `0x${compiled.evm.bytecode.object}` as Hex,
        args,
        account: caller,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success' || !receipt.contractAddress) {
        throw new Error(`Déploiement local échoué: ${contractName}.`);
      }
      return receipt.contractAddress;
    };

    const router = await deploy('MockSafetyProbeRouter');
    const token = await deploy(tokenContract, [router, ...tokenArgs]);
    const probe = await deploy('SafetyProbe');
    const pair: PairInfo = {
      factory: zeroAddress,
      router,
      wbnb: '0x000000000000000000000000000000000000bEEF',
      pair: '0x0000000000000000000000000000000000000001',
      token,
      token0: token,
      token1: '0x000000000000000000000000000000000000bEEF',
      createdBlock: 1n,
      blockHash: `0x${'00'.repeat(32)}` as Hash,
      createdTransactionHash: `0x${'01'.repeat(32)}` as Hash,
      createdLogIndex: 0,
      discoveredAtMs: 0,
    };
    const service = new SafetyProbeService(publicClient, {
      address: probe,
      caller,
      amountWei: 10_000n,
      deadlineSeconds: 300,
      nowMs: () => 2_000_000_000_000,
    });
    return {
      service,
      pair,
      close: () => connection.close(),
    };
  } catch (error) {
    await connection.close();
    throw error;
  }
}
