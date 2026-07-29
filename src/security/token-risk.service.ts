import { randomUUID } from 'node:crypto';
import {
  getAddress,
  isAddress,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { ownableAbi } from '../abi/ownable.abi.js';
import { pancakePairAbi } from '../abi/pancake-pair.abi.js';
import { config } from '../config/env.js';
import type { PairInfo, TokenMetadata } from '../types/domain.js';
import { errorMessage } from '../utils/error.js';
import { scanSensitiveSelectors } from './bytecode-scanner.js';
import { evaluateRisk } from './risk-evaluator.js';
import { RiskSettingsStore } from './risk-settings.store.js';
import {
  SafetyProbeService,
  type SafetyProbeResult,
} from './safety-probe.service.js';
import type { RiskCheck, TokenRiskReport } from './token-risk.types.js';

const EIP1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as Hex;
const DEAD = '0x000000000000000000000000000000000000dEaD' as Address;

function storageAddress(storage: Hex | undefined): Address | null {
  if (!storage || storage === '0x') return null;
  const candidate = `0x${storage.slice(-40)}`;
  if (!isAddress(candidate) || candidate.toLowerCase() === zeroAddress) return null;
  return getAddress(candidate);
}

export class TokenRiskService {
  constructor(
    private readonly client: PublicClient,
    private readonly riskSettings: RiskSettingsStore,
    private readonly safetyProbe = new SafetyProbeService(client),
  ) {}

  async analyze(input: {
    pair: PairInfo;
    metadata: TokenMetadata;
    blockNumber: bigint;
  }): Promise<TokenRiskReport> {
    const checks: RiskCheck[] = [];
    const bytecode = await this.client.getBytecode({ address: input.pair.token });

    checks.push({
      code: 'BYTECODE',
      label: 'Bytecode du token',
      status: bytecode && bytecode !== '0x' ? 'PASS' : 'FAIL',
      critical: true,
      penalty: bytecode && bytecode !== '0x' ? 0 : 100,
      message: bytecode && bytecode !== '0x'
        ? `${input.metadata.codeSizeBytes} octets de bytecode.`
        : 'Aucun bytecode trouvé.',
    });

    checks.push({
      code: 'TOKEN_METADATA',
      label: 'Interface BEP-20 minimale',
      status: input.metadata.totalSupply > 0n && input.metadata.decimals <= 36 ? 'PASS' : 'FAIL',
      critical: true,
      penalty: input.metadata.totalSupply > 0n && input.metadata.decimals <= 36 ? 0 : 100,
      message: `decimals=${input.metadata.decimals}, totalSupply=${input.metadata.totalSupply.toString()}`,
    });

    const liquidityWbnb = await this.readLiquidity(input.pair);
    const enoughLiquidity = liquidityWbnb >= config.minWbnbLiquidityWei;
    checks.push({
      code: 'WBNB_LIQUIDITY',
      label: 'Liquidité WBNB',
      status: enoughLiquidity ? 'PASS' : 'FAIL',
      critical: true,
      penalty: enoughLiquidity ? 0 : 100,
      message: enoughLiquidity
        ? 'La réserve WBNB dépasse le seuil minimal.'
        : 'Réserve WBNB insuffisante.',
      evidence: {
        liquidityWbnb: liquidityWbnb.toString(),
        minimumWbnb: config.minWbnbLiquidityWei.toString(),
      },
    });

    const owner = await this.readOwner(input.pair.token);
    if (owner === null) {
      checks.push({
        code: 'OWNER',
        label: 'Propriétaire du contrat',
        status: 'UNKNOWN',
        critical: false,
        penalty: 5,
        message: 'owner() absent ou non lisible.',
      });
    } else if (owner.toLowerCase() === zeroAddress) {
      checks.push({
        code: 'OWNER',
        label: 'Propriétaire du contrat',
        status: 'PASS',
        critical: false,
        penalty: 0,
        message: 'Ownership renoncé selon owner().',
        evidence: { owner },
      });
    } else {
      checks.push({
        code: 'OWNER',
        label: 'Propriétaire du contrat',
        status: 'WARN',
        critical: false,
        penalty: 20,
        message: 'Un propriétaire actif peut encore modifier le contrat.',
        evidence: { owner },
      });
    }

    const implementation = storageAddress(
      await this.client.getStorageAt({
        address: input.pair.token,
        slot: EIP1967_IMPLEMENTATION_SLOT,
      }),
    );
    const isMinimalProxy = Boolean(
      bytecode?.toLowerCase().includes('363d3d373d3d3d363d73'),
    );
    if (implementation || isMinimalProxy) {
      checks.push({
        code: 'PROXY',
        label: 'Contrat proxy',
        status: 'WARN',
        critical: false,
        penalty: 25,
        message: 'Le code peut être délégué ou modifiable.',
        evidence: { implementation, isMinimalProxy },
      });
    } else {
      checks.push({
        code: 'PROXY',
        label: 'Contrat proxy',
        status: 'PASS',
        critical: false,
        penalty: 0,
        message: 'Aucun indicateur proxy EIP-1967/EIP-1167 trouvé.',
      });
    }

    const selectorMatches = bytecode ? scanSensitiveSelectors(bytecode) : [];
    if (selectorMatches.length > 0) {
      const categories = [...new Set(selectorMatches.map((match) => match.category))];
      checks.push({
        code: 'SENSITIVE_SELECTORS',
        label: 'Fonctions sensibles',
        status: 'WARN',
        critical: false,
        penalty: Math.min(30, categories.length * 6),
        message: `Sélecteurs sensibles détectés: ${categories.join(', ')}.`,
        evidence: {
          signatures: selectorMatches.map((match) => match.signature),
          selectors: selectorMatches.map((match) => match.selector),
        },
      });
    } else {
      checks.push({
        code: 'SENSITIVE_SELECTORS',
        label: 'Fonctions sensibles',
        status: 'PASS',
        critical: false,
        penalty: 0,
        message: 'Aucun sélecteur connu détecté dans le bytecode.',
      });
    }

    const lpBurnedBps = await this.readLpBurnedBps(input.pair.pair);
    checks.push({
      code: 'LP_BURN',
      label: 'LP brûlée',
      status: lpBurnedBps !== null && lpBurnedBps >= 8000 ? 'PASS' : 'UNKNOWN',
      critical: false,
      penalty: lpBurnedBps !== null && lpBurnedBps >= 8000 ? 0 : 5,
      message: lpBurnedBps === null
        ? 'Impossible de lire la répartition LP.'
        : lpBurnedBps >= 8000
          ? `${lpBurnedBps / 100}% de LP envoyée aux adresses de burn.`
          : 'La LP n’est pas majoritairement brûlée; elle peut néanmoins être verrouillée ailleurs.',
      evidence: { lpBurnedBps },
    });

    let probe: SafetyProbeResult | null = null;
    try {
      probe = await this.safetyProbe.probe(input.pair);
      const probeFailure =
        probe.buyTaxBps > config.riskMaxBuyTaxBps ||
        probe.sellTaxBps > config.riskMaxSellTaxBps ||
        probe.roundTripLossBps > config.riskMaxRoundTripLossBps;
      checks.push({
        code: 'BUY_SELL_PROBE',
        label: 'Simulation achat/revente',
        status: probeFailure ? 'FAIL' : 'PASS',
        critical: true,
        penalty: probeFailure ? 100 : 0,
        message: probeFailure
          ? 'Taxes ou perte aller-retour supérieures aux limites.'
          : 'Achat et revente simulés avec succès.',
        evidence: {
          buyTaxBps: probe.buyTaxBps,
          sellTaxBps: probe.sellTaxBps,
          roundTripLossBps: probe.roundTripLossBps,
          quotedTokens: probe.quotedTokens.toString(),
          receivedTokens: probe.receivedTokens.toString(),
          quotedNative: probe.quotedNative.toString(),
          recoveredNative: probe.recoveredNative.toString(),
        },
      });
    } catch (error) {
      checks.push({
        code: 'BUY_SELL_PROBE',
        label: 'Simulation achat/revente',
        status: config.riskProbeRequired ? 'FAIL' : 'UNKNOWN',
        critical: config.riskProbeRequired,
        penalty: config.riskProbeRequired ? 100 : 20,
        message: `Simulation indisponible ou échouée: ${errorMessage(error)}`,
      });
    }

    const runtimeSettings = await this.riskSettings.get();
    const evaluation = evaluateRisk(checks, config.riskMinScore, runtimeSettings);
    return {
      id: randomUUID(),
      token: input.pair.token,
      pair: input.pair.pair,
      blockNumber: input.blockNumber,
      score: evaluation.score,
      verdict: evaluation.verdict,
      checks,
      summary: {
        liquidityWbnb,
        owner,
        implementation,
        lpBurnedBps,
        buyTaxBps: probe?.buyTaxBps ?? null,
        sellTaxBps: probe?.sellTaxBps ?? null,
        roundTripLossBps: probe?.roundTripLossBps ?? null,
        sensitiveSelectors: selectorMatches.map((match) => match.signature),
      },
      createdAtMs: Date.now(),
    };
  }

  private async readLiquidity(pair: PairInfo): Promise<bigint> {
    const [reserve0, reserve1] = await this.client.readContract({
      address: pair.pair,
      abi: pancakePairAbi,
      functionName: 'getReserves',
    });
    return pair.token0.toLowerCase() === pair.wbnb.toLowerCase() ? reserve0 : reserve1;
  }

  private async readOwner(token: Address): Promise<Address | null> {
    try {
      return await this.client.readContract({
        address: token,
        abi: ownableAbi,
        functionName: 'owner',
      });
    } catch {
      return null;
    }
  }

  private async readLpBurnedBps(pair: Address): Promise<number | null> {
    try {
      const [totalSupply, deadBalance, zeroBalance] = await Promise.all([
        this.client.readContract({ address: pair, abi: pancakePairAbi, functionName: 'totalSupply' }),
        this.client.readContract({ address: pair, abi: pancakePairAbi, functionName: 'balanceOf', args: [DEAD] }),
        this.client.readContract({ address: pair, abi: pancakePairAbi, functionName: 'balanceOf', args: [zeroAddress] }),
      ]);
      if (totalSupply === 0n) return 0;
      return Number(((deadBalance + zeroBalance) * 10_000n) / totalSupply);
    } catch {
      return null;
    }
  }

}
