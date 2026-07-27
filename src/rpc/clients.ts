import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  webSocket,
  type Account,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { AppConfig } from '../config/env.js';
import { getChain } from '../config/network.js';

export type AppPublicClient = PublicClient<Transport, Chain>;
export type AppWalletClient = WalletClient<Transport, Chain, Account>;

export interface RpcClients {
  chain: Chain;
  publicClient: AppPublicClient;
  subscriptionClient: AppPublicClient;
  walletClient: AppWalletClient | undefined;
  account: Account | undefined;
  traderAddress: Address | undefined;
}

function createHttpTransport(urls: readonly string[]): Transport {
  const transports = urls.map((url) =>
    http(url, {
      retryCount: 3,
      retryDelay: 250,
      timeout: 15_000,
    }),
  );
  const first = transports[0];
  if (first === undefined) {
    throw new Error('Aucun transport HTTP configuré.');
  }
  if (transports.length === 1) {
    return first;
  }
  return fallback(transports, {
    rank: true,
    retryCount: 3,
    retryDelay: 250,
  });
}

function createWebSocketTransport(urls: readonly string[]): Transport {
  const transports = urls.map((url) =>
    webSocket(url, {
      reconnect: {
        attempts: 50,
        delay: 1_000,
      },
      retryCount: 5,
      retryDelay: 500,
      timeout: 15_000,
    }),
  );
  const first = transports[0];
  if (first === undefined) {
    throw new Error('Aucun transport WebSocket configuré.');
  }
  if (transports.length === 1) {
    return first;
  }
  return fallback(transports, {
    retryCount: 5,
    retryDelay: 500,
  });
}

export function createRpcClients(config: AppConfig): RpcClients {
  const chain = getChain(config.network);
  const publicClient = createPublicClient({
    chain,
    transport: createHttpTransport(config.httpUrls),
    pollingInterval: 1_000,
  }) as AppPublicClient;

  const subscriptionClient = createPublicClient({
    chain,
    transport: createWebSocketTransport(config.wssUrls),
    pollingInterval: 1_000,
  }) as AppPublicClient;

  const account = config.privateKey === undefined ? undefined : privateKeyToAccount(config.privateKey);
  const walletClient =
    account === undefined
      ? undefined
      : (createWalletClient({
          account,
          chain,
          transport: http(config.txHttpUrl ?? config.httpUrls[0], {
            retryCount: 2,
            retryDelay: 150,
            timeout: 15_000,
          }),
        }) as AppWalletClient);

  return {
    chain,
    publicClient,
    subscriptionClient,
    walletClient,
    account,
    traderAddress: account?.address ?? config.simulationAccount,
  };
}

export async function assertExpectedChain(clients: RpcClients): Promise<void> {
  const chainId = await clients.publicClient.getChainId();
  if (chainId !== clients.chain.id) {
    throw new Error(`Le RPC répond avec chainId=${chainId}, mais le projet attend chainId=${clients.chain.id}.`);
  }
}
