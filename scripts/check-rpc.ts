import { formatEther, isAddressEqual } from 'viem';
import { pancakeRouterAbi } from '../src/abi/pancake-router.abi.js';
import { loadConfig } from '../src/config/env.js';
import { getPancakeV2Contracts } from '../src/config/network.js';
import { assertExpectedChain, createRpcClients } from '../src/rpc/clients.js';

const config = loadConfig();
const contracts = getPancakeV2Contracts(config.network);
const clients = createRpcClients(config);
await assertExpectedChain(clients);

const [blockNumber, factory, wbnb] = await Promise.all([
  clients.publicClient.getBlockNumber(),
  clients.publicClient.readContract({
    address: contracts.router,
    abi: pancakeRouterAbi,
    functionName: 'factory',
  }),
  clients.publicClient.readContract({
    address: contracts.router,
    abi: pancakeRouterAbi,
    functionName: 'WETH',
  }),
]);

const output: Record<string, unknown> = {
  network: config.network,
  expectedChainId: clients.chain.id,
  latestBlock: blockNumber.toString(),
  router: contracts.router,
  configuredFactory: contracts.factory,
  routerFactory: factory,
  factoryMatches: isAddressEqual(factory, contracts.factory),
  wbnb,
  executionMode: config.executionMode,
};

if (clients.traderAddress !== undefined) {
  const balance = await clients.publicClient.getBalance({ address: clients.traderAddress });
  output.traderAddress = clients.traderAddress;
  output.traderBalanceBnb = formatEther(balance);
}

console.log(JSON.stringify(output, null, 2));
