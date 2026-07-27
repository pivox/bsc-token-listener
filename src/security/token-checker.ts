import { isAddress, type Address, type Hex } from 'viem';
import { erc20Abi } from '../abi/erc20.abi.js';
import type { TokenMetadata } from '../types/domain.js';
import type { AppPublicClient } from '../rpc/clients.js';

export interface TokenCheckResult {
  accepted: boolean;
  metadata: TokenMetadata | undefined;
  reason: string | undefined;
}

function codeSize(code: Hex): number {
  return Math.max(0, (code.length - 2) / 2);
}

export class TokenChecker {
  public constructor(private readonly publicClient: AppPublicClient) {}

  public async inspect(address: Address): Promise<TokenCheckResult> {
    try {
      if (!isAddress(address)) {
        return { accepted: false, metadata: undefined, reason: 'Adresse token invalide.' };
      }

      const code = await this.publicClient.getCode({ address });
      if (code === undefined || code === '0x') {
        return { accepted: false, metadata: undefined, reason: 'Aucun bytecode au contrat token.' };
      }

      const [name, symbol, decimals, totalSupply] = await Promise.all([
        this.publicClient.readContract({ address, abi: erc20Abi, functionName: 'name' }),
        this.publicClient.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
        this.publicClient.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
        this.publicClient.readContract({ address, abi: erc20Abi, functionName: 'totalSupply' }),
      ]);

      const normalizedName = name.trim();
      const normalizedSymbol = symbol.trim();
      const normalizedDecimals = Number(decimals);

      if (normalizedName.length === 0 || normalizedName.length > 128) {
        return { accepted: false, metadata: undefined, reason: 'Nom BEP-20 absent ou anormal.' };
      }
      if (normalizedSymbol.length === 0 || normalizedSymbol.length > 32) {
        return { accepted: false, metadata: undefined, reason: 'Symbole BEP-20 absent ou anormal.' };
      }
      if (!Number.isInteger(normalizedDecimals) || normalizedDecimals < 0 || normalizedDecimals > 36) {
        return { accepted: false, metadata: undefined, reason: 'Nombre de décimales hors limites.' };
      }
      if (totalSupply <= 0n) {
        return { accepted: false, metadata: undefined, reason: 'Supply totale nulle.' };
      }

      return {
        accepted: true,
        metadata: {
          address,
          name: normalizedName,
          symbol: normalizedSymbol,
          decimals: normalizedDecimals,
          totalSupply,
          codeSizeBytes: codeSize(code),
        },
        reason: undefined,
      };
    } catch (error) {
      return {
        accepted: false,
        metadata: undefined,
        reason: `Interface BEP-20 illisible: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
