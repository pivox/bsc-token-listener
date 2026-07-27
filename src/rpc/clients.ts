import {
  createPublicClient,
  createWalletClient,
  http,
  webSocket,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chain } from '../config/chain.js';
import { config } from '../config/env.js';

export const publicClient = createPublicClient({
  chain,
  transport: http(config.httpRpcUrl, {
    retryCount: 3,
    retryDelay: 250,
    timeout: 20_000,
  }),
});

export const wsClient = createPublicClient({
  chain,
  transport: webSocket(config.wsRpcUrl, {
    reconnect: true,
    retryCount: 10,
    retryDelay: 500,
    timeout: 20_000,
  }),
});

export const account = config.privateKey
  ? privateKeyToAccount(config.privateKey)
  : undefined;

export const walletClient = account
  ? createWalletClient({
      account,
      chain,
      transport: http(config.httpRpcUrl, {
        retryCount: 3,
        retryDelay: 250,
        timeout: 20_000,
      }),
    })
  : undefined;
