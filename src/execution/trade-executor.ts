import { randomUUID } from 'node:crypto';
import { maxUint256, type Hash } from 'viem';
import { erc20Abi } from '../abi/erc20.abi.js';
import { pancakeRouterAbi } from '../abi/pancake-router.abi.js';
import { config } from '../config/env.js';
import { account, publicClient, walletClient } from '../rpc/clients.js';
import { TradeRepository } from '../storage/repositories.js';
import type {
  EntryExecution,
  ExitExecution,
  TokenSession,
  TradeRecord,
} from '../types/domain.js';
import { TransactionQueue } from './transaction-queue.js';

function minimumOut(quoted: bigint): bigint {
  return (quoted * BigInt(10_000 - config.slippageBps)) / 10_000n;
}

function deadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + config.txDeadlineSeconds);
}

export class TradeExecutor {
  private readonly queue = new TransactionQueue();

  constructor(private readonly trades: TradeRepository) {}

  async buy(session: TokenSession): Promise<EntryExecution> {
    return this.queue.run(async () => {
      const path = [session.pair.wbnb, session.pair.token] as const;
      const quoted = await publicClient.readContract({
        address: session.pair.router,
        abi: pancakeRouterAbi,
        functionName: 'getAmountsOut',
        args: [config.buyAmountWei, [...path]],
      });
      const amountOut = quoted[quoted.length - 1] ?? 0n;
      const trade = this.newTrade(session, 'BUY', config.buyAmountWei, amountOut);
      await this.trades.save(trade);

      if (config.executionMode === 'dry-run') {
        trade.status = 'SIMULATED';
        trade.updatedAtMs = Date.now();
        await this.trades.save(trade);
        return {
          mode: 'dry-run',
          amountInWei: config.buyAmountWei,
          amountOutToken: amountOut,
          confirmedAtMs: Date.now(),
          cursor: {
            blockNumber: session.firstBuy!.cursor.blockNumber,
            transactionIndex: Number.MAX_SAFE_INTEGER,
            logIndex: Number.MAX_SAFE_INTEGER,
          },
        };
      }

      if (!walletClient || !account) throw new Error('Wallet live non initialisé.');
      const balanceBefore = await publicClient.readContract({
        address: session.pair.token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      });
      const hash = await walletClient.writeContract({
        address: session.pair.router,
        abi: pancakeRouterAbi,
        functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens',
        args: [minimumOut(amountOut), [...path], account.address, deadline()],
        value: config.buyAmountWei,
        account,
      });
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
        timeout: 120_000,
      });
      if (receipt.status !== 'success') throw new Error(`Achat échoué: ${hash}`);
      const balanceAfter = await publicClient.readContract({
        address: session.pair.token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      });
      const received = (balanceAfter as bigint) - (balanceBefore as bigint);

      trade.status = 'CONFIRMED';
      trade.transactionHash = hash;
      trade.amountOut = received;
      trade.blockNumber = receipt.blockNumber;
      trade.updatedAtMs = Date.now();
      await this.trades.save(trade);

      return {
        mode: 'live',
        amountInWei: config.buyAmountWei,
        amountOutToken: received,
        transactionHash: hash,
        confirmedAtMs: Date.now(),
        cursor: {
          blockNumber: receipt.blockNumber,
          transactionIndex: receipt.transactionIndex,
          logIndex: Number.MAX_SAFE_INTEGER,
        },
      };
    });
  }

  async sell(session: TokenSession): Promise<ExitExecution> {
    return this.queue.run(async () => {
      const amountIn = session.entry?.amountOutToken ?? 0n;
      if (amountIn <= 0n) throw new Error('Aucun token à vendre.');
      const path = [session.pair.token, session.pair.wbnb] as const;
      const quoted = await publicClient.readContract({
        address: session.pair.router,
        abi: pancakeRouterAbi,
        functionName: 'getAmountsOut',
        args: [amountIn, [...path]],
      });
      const amountOut = quoted[quoted.length - 1] ?? 0n;
      const trade = this.newTrade(session, 'SELL', amountIn, amountOut);
      await this.trades.save(trade);

      if (config.executionMode === 'dry-run') {
        trade.status = 'SIMULATED';
        trade.updatedAtMs = Date.now();
        await this.trades.save(trade);
        return {
          mode: 'dry-run',
          amountInToken: amountIn,
          amountOutWei: amountOut,
          confirmedAtMs: Date.now(),
        };
      }

      if (!walletClient || !account) throw new Error('Wallet live non initialisé.');
      const walletBalance = await publicClient.readContract({
        address: session.pair.token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      });
      if ((walletBalance as bigint) <= 0n) throw new Error('Solde token nul.');

      const approveHash = await walletClient.writeContract({
        address: session.pair.token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [session.pair.router, maxUint256],
        account,
      });
      const approveReceipt = await publicClient.waitForTransactionReceipt({
        hash: approveHash,
        confirmations: 1,
        timeout: 120_000,
      });
      if (approveReceipt.status !== 'success') {
        throw new Error(`Approve échoué: ${approveHash}`);
      }

      let hash: Hash;
      try {
        hash = await walletClient.writeContract({
          address: session.pair.router,
          abi: pancakeRouterAbi,
          functionName: 'swapExactTokensForETHSupportingFeeOnTransferTokens',
          args: [walletBalance as bigint, minimumOut(amountOut), [...path], account.address, deadline()],
          account,
        });
      } catch (error) {
        trade.status = 'FAILED';
        trade.error = error instanceof Error ? error.message : String(error);
        trade.updatedAtMs = Date.now();
        await this.trades.save(trade);
        throw error;
      }

      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
        timeout: 120_000,
      });
      if (receipt.status !== 'success') throw new Error(`Vente échouée: ${hash}`);

      trade.status = 'CONFIRMED';
      trade.transactionHash = hash;
      trade.blockNumber = receipt.blockNumber;
      trade.updatedAtMs = Date.now();
      await this.trades.save(trade);
      return {
        mode: 'live',
        amountInToken: walletBalance as bigint,
        amountOutWei: amountOut,
        transactionHash: hash,
        confirmedAtMs: Date.now(),
      };
    });
  }

  private newTrade(
    session: TokenSession,
    side: 'BUY' | 'SELL',
    amountIn: bigint,
    amountOut: bigint,
  ): TradeRecord {
    const now = Date.now();
    return {
      id: randomUUID(),
      pair: session.pair.pair,
      token: session.pair.token,
      side,
      mode: config.executionMode,
      status: 'PENDING',
      amountIn,
      amountOut,
      createdAtMs: now,
      updatedAtMs: now,
    };
  }
}
