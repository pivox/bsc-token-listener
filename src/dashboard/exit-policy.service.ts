import type { SessionRepository } from '../storage/repositories.js';
import { evaluatePositionExit } from '../strategy/position-exit-evaluator.js';
import {
  parsePositionExitSettings,
  type PositionExitSettings,
} from '../strategy/position-exit-settings.js';
import type { PositionExitSettingsProvider } from '../strategy/position-exit-settings.provider.js';

export type PositionExitSettingsDto = Omit<
  PositionExitSettings,
  'emergencyMaxGasWei' | 'approvalGasUnits' | 'sellGasUnits'
> & {
  emergencyMaxGasWei: string;
  approvalGasUnits: string;
  sellGasUnits: string;
};

export interface ExitPolicySettingsView {
  settings: PositionExitSettingsDto;
  defaults: PositionExitSettingsDto;
  revision: number;
  source: 'ENV' | 'DATABASE';
  updatedAt: string | null;
}

export interface ExitPolicyPreview {
  settings: PositionExitSettingsDto;
  revision: number;
  affectedPositions: string[];
  decisions: Array<{
    pair: string;
    action: string;
    primaryRule: string | null;
  }>;
}

function dto(
  settings: Readonly<PositionExitSettings>,
): PositionExitSettingsDto {
  return {
    ...settings,
    emergencyMaxGasWei: settings.emergencyMaxGasWei.toString(),
    approvalGasUnits: settings.approvalGasUnits.toString(),
    sellGasUnits: settings.sellGasUnits.toString(),
  };
}

function candidate(value: unknown): Readonly<PositionExitSettings> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return parsePositionExitSettings(value);
  }
  const record = { ...(value as Record<string, unknown>) };
  for (const key of [
    'emergencyMaxGasWei',
    'approvalGasUnits',
    'sellGasUnits',
  ]) {
    if (typeof record[key] === 'string' && /^\d+$/u.test(record[key])) {
      record[key] = BigInt(record[key]);
    }
  }
  return parsePositionExitSettings(record);
}

export class ExitPolicyDashboardService {
  constructor(
    private readonly provider: Pick<
      PositionExitSettingsProvider,
      'get' | 'update' | 'reset'
    >,
    private readonly sessions: Pick<SessionRepository, 'loadHolding'>,
    private readonly defaults: Readonly<PositionExitSettings>,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<ExitPolicySettingsView> {
    const effective = await this.provider.get();
    return {
      settings: dto(effective.settings),
      defaults: dto(this.defaults),
      revision: effective.revision,
      source: effective.source,
      updatedAt: effective.updatedAt,
    };
  }

  async preview(
    value: unknown,
    expectedRevision: number,
  ): Promise<ExitPolicyPreview> {
    const effective = await this.provider.get();
    this.assertRevision(expectedRevision, effective.revision);
    const settings = candidate(value);
    const decisions: ExitPolicyPreview['decisions'] = [];
    const nowMs = this.now();
    for (const session of await this.sessions.loadHolding()) {
      if (!session.entry) continue;
      const state = session.exitPolicy;
      if (
        state?.latestNetValueWei === undefined ||
        state.currentLiquidityWbnbWei === undefined
      ) {
        continue;
      }
      const result = evaluatePositionExit({
        settings,
        state,
        metrics: {
          quoteWei: state.latestNetValueWei,
          entryCostWei:
            session.entry.amountInWei + (session.entry.gasCostWei ?? 0n),
          netExitValueWei: state.latestNetValueWei,
          currentLiquidityWbnbWei: state.currentLiquidityWbnbWei,
          estimatedExitGasWei: state.lastEstimatedExitGasWei ?? 0n,
          sellTaxBps: state.lastSellTaxBps ?? 10_000,
          probeStatus: state.lastProbeStatus ?? 'UNKNOWN',
          probeMeasuredAtMs: state.lastProbeAtMs ?? nowMs,
        },
        nowMs,
        openedAtMs: session.entry.confirmedAtMs,
        observedBuysAfterEntry: session.subsequentBuyCount,
      });
      decisions.push({
        pair: session.pair.pair,
        action: result.action,
        primaryRule: result.primaryRule ?? null,
      });
    }
    return {
      settings: dto(settings),
      revision: effective.revision,
      affectedPositions: decisions
        .filter(({ action }) => action !== 'HOLD')
        .map(({ pair }) => pair),
      decisions,
    };
  }

  async update(
    value: unknown,
    expectedRevision: number,
  ): Promise<ExitPolicySettingsView> {
    const committed = await this.provider.update(
      candidate(value),
      expectedRevision,
    );
    return {
      settings: dto(committed.settings),
      defaults: dto(this.defaults),
      revision: committed.revision,
      source: committed.source,
      updatedAt: committed.updatedAt,
    };
  }

  async reset(expectedRevision: number): Promise<ExitPolicySettingsView> {
    const committed = await this.provider.reset(expectedRevision);
    return {
      settings: dto(committed.settings),
      defaults: dto(this.defaults),
      revision: committed.revision,
      source: committed.source,
      updatedAt: committed.updatedAt,
    };
  }

  private assertRevision(expected: number, actual: number): void {
    if (!Number.isSafeInteger(expected) || expected < 0 || expected !== actual) {
      throw new Error(
        `Conflit de révision: attendu ${expected}, courant ${actual}.`,
      );
    }
  }
}
