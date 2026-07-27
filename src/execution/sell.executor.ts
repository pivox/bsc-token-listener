import type { Hash } from 'viem';
import { erc20Abi } from '../abi/erc20.abi.js';
import { pancakeRouterAbi } from '../abi/pancake-router.abi.js';
import type { AppConfig } from '../config/env.js';
import type { RpcClients } from '../rpc/clients.js';
import { NonceManager } from '../rpc/nonce-manager.js';
import { TokenSession } from '../strategy/token-session.js';
import type { ChainCursor, ExecutionResult } from '../types/domain.js';
import { applySlippage } from '../utils/math.js';
import { ApproveExecutor } from './approve.executor.js';
import { BroadcastedTransactionError } from './errors.js';
import { findPairSwapInReceipt } from './receipt-parser.js';

type BroadcastCallback = (hash: Hash) => Promise<void>;

export class SellExecutor {
  public constructor(
    private readonly config: AppConfig,
    private readonly clients: RpcClients,
    private readonly nonceManager: NonceManager | undefined,
    private readonly approveExecutor: ApproveExecutor,
  ) {}

  public async execute(
    session: TokenSession,
    onBroadcast: BroadcastCallback = async () => {},
  ): Promise<ExecutionResult> {
    const snapshot = session.snapshot;
    const entry = snapshot.entry;
    if (entry === undefined) {
      throw new Error("Aucune position d'entrée à vendre.");
    }

    const tokenAmount =
      this.config.executionMode === 'dry-run'
        ? entry.amountOutToken
        : await this.readLiveBalance(snapshot.pair.token);
    if (tokenAmount <= 0n) {
      throw new Error('Solde token nul au moment de la vente.');
    }

    const amounts = await this.clients.publicClient.readContract({
      address: snapshot.pair.router,
      abi: pancakeRouterAbi,
      functionName: 'getAmountsOut',
      args: [tokenAmount, [snapshot.pair.token, snapshot.pair.wbnb]],
    });
    const quotedOut = amounts.at(-1) ?? 0n;
    if (quotedOut <= 0n) {
      throw new Error('Le routeur ne fournit aucune sortie WBNB pour la vente.');
    }

    if (this.config.executionMode === 'dry-run') {
      const cursor = this.virtualExitCursor(snapshot.lastProcessedCursor ?? entry.cursor);
      return {
        mode: 'dry-run',
        transactionHash: undefined,
        cursor,
        amountIn: tokenAmount,
        amountOut: quotedOut,
        blockNumber: cursor.blockNumber,
      };
    }

    const account = this.clients.account;
    const walletClient = this.clients.walletClient;
    const traderAddress = this.clients.traderAddress;
    const nonceManager = this.nonceManager;
    if (
      account === undefined ||
      walletClient === undefined ||
      traderAddress === undefined ||
      nonceManager === undefined
    ) {
      throw new Error('Wallet live non configuré pour la vente.');
    }

    await this.approveExecutor.ensureAllowance(
      snapshot.pair.token,
      snapshot.pair.router,
      tokenAmount,
    );

    const deadline = BigInt(Math.floor(Date.now() / 1000) + this.config.txDeadlineSeconds);
    const minimumOut = applySlippage(quotedOut, this.config.sellSlippageBps);
    const { request } = await this.clients.publicClient.simulateContract({
      account,
      address: snapshot.pair.router,
      abi: pancakeRouterAbi,
      functionName: 'swapExactTokensForETHSupportingFeeOnTransferTokens',
      args: [
        tokenAmount,
        minimumOut,
        [snapshot.pair.token, snapshot.pair.wbnb],
        traderAddress,
        deadline,
      ],
    });

    const hash = await nonceManager.send<Hash>((nonce) =>
      walletClient.writeContract({ ...request, nonce }),
    );
    try {
      await onBroadcast(hash);
    } catch (error) {
      throw new BroadcastedTransactionError(
        `Vente diffusée (${hash}) mais impossible de persister immédiatement son hash.`,
        hash,
        'UNKNOWN',
        error,
      );
    }

    let receipt;
    try {
      receipt = await this.clients.publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
        timeout: 120_000,
      });
    } catch (error) {
      throw new BroadcastedTransactionError(
        `Vente diffusée (${hash}) mais reçu non confirmé dans le délai.`,
        hash,
        'UNKNOWN',
        error,
      );
    }
    if (receipt.status !== 'success') {
      throw new BroadcastedTransactionError(`Vente révoquée: ${hash}`, hash, 'REVERTED');
    }

    try {
      const swap = findPairSwapInReceipt(receipt, snapshot.pair);
      if (swap === undefined || swap.kind !== 'SELL') {
        throw new Error('Impossible de retrouver le Swap de vente dans le reçu.');
      }

      return {
        mode: 'live',
        transactionHash: hash,
        cursor: swap.cursor,
        amountIn: tokenAmount,
        amountOut: swap.amountWbnb,
        blockNumber: receipt.blockNumber,
      };
    } catch (error) {
      throw new BroadcastedTransactionError(
        `Vente confirmée (${hash}) mais résultat métier non réconcilié.`,
        hash,
        'CONFIRMED_UNPARSED',
        error,
      );
    }
  }

  private async readLiveBalance(token: `0x${string}`): Promise<bigint> {
    const traderAddress = this.clients.traderAddress;
    if (traderAddress === undefined) {
      throw new Error('Adresse trader absente.');
    }
    return (await this.clients.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [traderAddress],
    })) as bigint;
  }

  private virtualExitCursor(cursor: ChainCursor): ChainCursor {
    return {
      blockNumber: cursor.blockNumber,
      transactionIndex: cursor.transactionIndex,
      logIndex: cursor.logIndex + 1,
    };
  }
}
