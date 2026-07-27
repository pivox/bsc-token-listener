import type { Hash } from 'viem';
import { erc20Abi } from '../abi/erc20.abi.js';
import { pancakeRouterAbi } from '../abi/pancake-router.abi.js';
import type { AppConfig } from '../config/env.js';
import type { RpcClients } from '../rpc/clients.js';
import { NonceManager } from '../rpc/nonce-manager.js';
import { TokenSession } from '../strategy/token-session.js';
import type { ExecutionResult } from '../types/domain.js';
import { applySlippage } from '../utils/math.js';
import { BroadcastedTransactionError } from './errors.js';
import { findPairSwapInReceipt } from './receipt-parser.js';

type BroadcastCallback = (hash: Hash) => Promise<void>;

export class BuyExecutor {
  public constructor(
    private readonly config: AppConfig,
    private readonly clients: RpcClients,
    private readonly nonceManager: NonceManager | undefined,
  ) {}

  public async execute(
    session: TokenSession,
    onBroadcast: BroadcastCallback = async () => {},
  ): Promise<ExecutionResult> {
    const snapshot = session.snapshot;
    const trigger = snapshot.firstBuy;
    if (trigger === undefined) {
      throw new Error("Aucun premier achat n'est enregistré pour cette session.");
    }

    const amounts = await this.clients.publicClient.readContract({
      address: snapshot.pair.router,
      abi: pancakeRouterAbi,
      functionName: 'getAmountsOut',
      args: [this.config.buyAmountWei, [snapshot.pair.wbnb, snapshot.pair.token]],
    });
    const quotedOut = amounts.at(-1) ?? 0n;
    if (quotedOut <= 0n) {
      throw new Error("Le routeur ne fournit aucune quantité de token à l'achat.");
    }

    if (this.config.executionMode === 'dry-run') {
      const currentBlock = await this.clients.publicClient.getBlockNumber();
      return {
        mode: 'dry-run',
        transactionHash: undefined,
        // Place l'entrée virtuelle à la fin du bloc courant afin de ne pas
        // compter les achats reçus pendant les contrôles comme postérieurs.
        cursor: {
          blockNumber: currentBlock,
          transactionIndex: Number.MAX_SAFE_INTEGER,
          logIndex: Number.MAX_SAFE_INTEGER,
        },
        amountIn: this.config.buyAmountWei,
        amountOut: quotedOut,
        blockNumber: currentBlock,
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
      throw new Error("Wallet live non configuré pour l'achat.");
    }

    const beforeBalance = (await this.clients.publicClient.readContract({
      address: snapshot.pair.token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [traderAddress],
    })) as bigint;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + this.config.txDeadlineSeconds);
    const minimumOut = applySlippage(quotedOut, this.config.buySlippageBps);
    const { request } = await this.clients.publicClient.simulateContract({
      account,
      address: snapshot.pair.router,
      abi: pancakeRouterAbi,
      functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens',
      args: [minimumOut, [snapshot.pair.wbnb, snapshot.pair.token], traderAddress, deadline],
      value: this.config.buyAmountWei,
    });

    const hash = await nonceManager.send<Hash>((nonce) =>
      walletClient.writeContract({ ...request, nonce }),
    );
    try {
      await onBroadcast(hash);
    } catch (error) {
      throw new BroadcastedTransactionError(
        `Achat diffusé (${hash}) mais impossible de persister immédiatement son hash.`,
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
        `Achat diffusé (${hash}) mais reçu non confirmé dans le délai.`,
        hash,
        'UNKNOWN',
        error,
      );
    }
    if (receipt.status !== 'success') {
      throw new BroadcastedTransactionError(`Achat révoqué: ${hash}`, hash, 'REVERTED');
    }

    try {
      const afterBalance = (await this.clients.publicClient.readContract({
        address: snapshot.pair.token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [traderAddress],
      })) as bigint;
      const received = afterBalance - beforeBalance;
      if (received <= 0n) {
        throw new Error("L'achat est confirmé mais aucun token reçu n'a pu être mesuré.");
      }

      const swap = findPairSwapInReceipt(receipt, snapshot.pair);
      if (swap === undefined || swap.kind !== 'BUY') {
        throw new Error("Impossible de retrouver le Swap d'achat dans le reçu.");
      }

      return {
        mode: 'live',
        transactionHash: hash,
        cursor: swap.cursor,
        amountIn: this.config.buyAmountWei,
        amountOut: received,
        blockNumber: receipt.blockNumber,
      };
    } catch (error) {
      throw new BroadcastedTransactionError(
        `Achat confirmé (${hash}) mais résultat métier non réconcilié.`,
        hash,
        'CONFIRMED_UNPARSED',
        error,
      );
    }
  }
}
