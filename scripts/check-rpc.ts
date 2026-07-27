import 'dotenv/config';
import { pancakeRouterAbi } from '../src/abi/pancake-router.abi.js';
import { chain } from '../src/config/chain.js';
import { config } from '../src/config/env.js';
import { publicClient } from '../src/rpc/clients.js';

const [chainId, latestBlock, routerFactory, wbnb] = await Promise.all([
  publicClient.getChainId(),
  publicClient.getBlockNumber(),
  publicClient.readContract({
    address: config.router,
    abi: pancakeRouterAbi,
    functionName: 'factory',
  }),
  publicClient.readContract({
    address: config.router,
    abi: pancakeRouterAbi,
    functionName: 'WETH',
  }),
]);

console.log(JSON.stringify({
  network: config.network,
  expectedChainId: chain.id,
  chainId,
  latestBlock: latestBlock.toString(),
  router: config.router,
  configuredFactory: config.factory,
  routerFactory,
  factoryMatches: routerFactory.toLowerCase() === config.factory.toLowerCase(),
  wbnb,
  executionMode: config.executionMode,
  riskPolicy: config.riskPolicy,
  safetyProbeConfigured: Boolean(config.safetyProbeAddress),
}, null, 2));
