export interface PositionExitSettings {
  monitorIntervalSeconds: number;
  maxHoldingMinutes: number;
  stopLossBps: number;
  takeProfitBps: number;
  liquidityDropBps: number;
  probeIntervalSeconds: number;
  quoteBufferBps: number;
  maxGasValueBps: number;
  emergencyMaxGasWei: bigint;
  approvalGasUnits: bigint;
  sellGasUnits: bigint;
  trailingEnabled: boolean;
  trailingActivationBps: number;
  trailingDrawdownBps: number;
  targetBuysAfterEntry: number;
}

const DEFAULTS: PositionExitSettings = {
  monitorIntervalSeconds: 15,
  maxHoldingMinutes: 30,
  stopLossBps: 1_000,
  takeProfitBps: 2_000,
  liquidityDropBps: 2_000,
  probeIntervalSeconds: 60,
  quoteBufferBps: 1_500,
  maxGasValueBps: 1_000,
  emergencyMaxGasWei: 10_000_000_000_000_000n,
  approvalGasUnits: 80_000n,
  sellGasUnits: 350_000n,
  trailingEnabled: false,
  trailingActivationBps: 2_000,
  trailingDrawdownBps: 500,
  targetBuysAfterEntry: 3,
};

const KEYS = Object.keys(DEFAULTS) as (keyof PositionExitSettings)[];

function integer(
  value: unknown,
  name: keyof PositionExitSettings,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${name} doit être un entier entre ${minimum} et ${maximum}.`);
  }
  return value;
}

function bigint(
  value: unknown,
  name: keyof PositionExitSettings,
  minimum: bigint,
  maximum?: bigint,
): bigint {
  if (
    typeof value !== 'bigint' ||
    value < minimum ||
    (maximum !== undefined && value > maximum)
  ) {
    throw new Error(`${name} doit être un bigint dans la plage autorisée.`);
  }
  return value;
}

export function parsePositionExitSettings(
  value: unknown,
): Readonly<PositionExitSettings> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Les réglages de sortie doivent être un objet.');
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find(
    (key) => !KEYS.includes(key as keyof PositionExitSettings),
  );
  if (unknown) {
    throw new Error(`Champ de réglage inconnu: ${unknown}.`);
  }
  for (const key of KEYS) {
    if (!(key in record)) {
      throw new Error(`Réglage obligatoire manquant: ${key}.`);
    }
  }

  const parsed: PositionExitSettings = {
    monitorIntervalSeconds: integer(record.monitorIntervalSeconds, 'monitorIntervalSeconds', 5, 300),
    maxHoldingMinutes: integer(record.maxHoldingMinutes, 'maxHoldingMinutes', 1, 10_080),
    stopLossBps: integer(record.stopLossBps, 'stopLossBps', 1, 10_000),
    takeProfitBps: integer(record.takeProfitBps, 'takeProfitBps', 1, 100_000),
    liquidityDropBps: integer(record.liquidityDropBps, 'liquidityDropBps', 1, 10_000),
    probeIntervalSeconds: integer(record.probeIntervalSeconds, 'probeIntervalSeconds', 15, 3_600),
    quoteBufferBps: integer(record.quoteBufferBps, 'quoteBufferBps', 0, 5_000),
    maxGasValueBps: integer(record.maxGasValueBps, 'maxGasValueBps', 1, 10_000),
    emergencyMaxGasWei: bigint(record.emergencyMaxGasWei, 'emergencyMaxGasWei', 1n),
    approvalGasUnits: bigint(record.approvalGasUnits, 'approvalGasUnits', 21_000n, 1_000_000n),
    sellGasUnits: bigint(record.sellGasUnits, 'sellGasUnits', 21_000n, 2_000_000n),
    trailingEnabled:
      typeof record.trailingEnabled === 'boolean'
        ? record.trailingEnabled
        : (() => {
            throw new Error('trailingEnabled doit être un booléen.');
          })(),
    trailingActivationBps: integer(
      record.trailingActivationBps,
      'trailingActivationBps',
      1,
      100_000,
    ),
    trailingDrawdownBps: integer(
      record.trailingDrawdownBps,
      'trailingDrawdownBps',
      1,
      10_000,
    ),
    targetBuysAfterEntry: integer(record.targetBuysAfterEntry, 'targetBuysAfterEntry', 1, 1_000),
  };

  if (parsed.probeIntervalSeconds < parsed.monitorIntervalSeconds) {
    throw new Error("L'intervalle du probe doit être supérieur ou égal à celui du monitor.");
  }
  if (parsed.trailingDrawdownBps >= parsed.trailingActivationBps) {
    throw new Error("Le drawdown trailing doit être inférieur à son seuil d'activation.");
  }
  return Object.freeze({ ...parsed });
}

export function defaultPositionExitSettings(): Readonly<PositionExitSettings> {
  return parsePositionExitSettings(DEFAULTS);
}
