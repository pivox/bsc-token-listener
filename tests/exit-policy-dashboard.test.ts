import assert from 'node:assert/strict';
import test from 'node:test';
import { injectExitPolicyControls } from '../src/dashboard/exit-policy-controls.js';
import { ExitPolicyDashboardService } from '../src/dashboard/exit-policy.service.js';
import { renderDashboardPage } from '../src/dashboard/dashboard.page.js';
import { defaultPositionExitSettings } from '../src/strategy/position-exit-settings.js';
import type { EffectivePositionExitSettings } from '../src/strategy/position-exit.types.js';
import type { TokenSession } from '../src/types/domain.js';

function effective(): EffectivePositionExitSettings {
  return {
    settings: defaultPositionExitSettings(),
    revision: 4,
    source: 'DATABASE',
    updatedAt: new Date(0).toISOString(),
  };
}

test('prévisualise depuis les métriques persistées sans écrire ni vendre', async () => {
  let writes = 0;
  const current = effective();
  const service = new ExitPolicyDashboardService(
    {
      get: async () => current,
      update: async () => {
        writes += 1;
        return current;
      },
      reset: async () => {
        writes += 1;
        return current;
      },
    },
    {
      loadHolding: async () => [
        {
          pair: {
            pair: '0x1111111111111111111111111111111111111111',
          },
          entry: {
            amountInWei: 1_000n,
            amountOutToken: 1n,
            confirmedAtMs: 1,
          },
          subsequentBuyCount: 0,
          exitPolicy: {
            latestNetValueWei: 800n,
            currentLiquidityWbnbWei: 1_000n,
            referenceLiquidityWbnbWei: 1_000n,
            lastProbeStatus: 'SAFE',
            lastProbeAtMs: 1,
            lastSellTaxBps: 0,
          },
        } as unknown as TokenSession,
      ],
    },
    defaultPositionExitSettings(),
    () => 2,
  );

  const preview = await service.preview(
    {
      ...current.settings,
      emergencyMaxGasWei: current.settings.emergencyMaxGasWei.toString(),
      approvalGasUnits: current.settings.approvalGasUnits.toString(),
      sellGasUnits: current.settings.sellGasUnits.toString(),
    },
    4,
  );
  assert.deepEqual(preview.affectedPositions, [
    '0x1111111111111111111111111111111111111111',
  ]);
  assert.equal(writes, 0);
});

test('refuse une révision périmée et un champ inconnu', async () => {
  const service = new ExitPolicyDashboardService(
    {
      get: async () => effective(),
      update: async () => effective(),
      reset: async () => effective(),
    },
    { loadHolding: async () => [] },
    defaultPositionExitSettings(),
  );
  await assert.rejects(
    service.preview(defaultPositionExitSettings(), 3),
    /révision/u,
  );
  await assert.rejects(
    service.preview(
      { ...defaultPositionExitSettings(), unknown: true },
      4,
    ),
    /inconnu/u,
  );
});

test('injecte tous les réglages et les flux preview, update et reset', () => {
  const html = injectExitPolicyControls(
    renderDashboardPage('nonce', 5),
    'nonce',
  );
  for (const field of [
    'monitorIntervalSeconds',
    'maxHoldingMinutes',
    'stopLossBps',
    'takeProfitBps',
    'liquidityDropBps',
    'probeIntervalSeconds',
    'quoteBufferBps',
    'maxGasValueBps',
    'emergencyMaxGasWei',
    'approvalGasUnits',
    'sellGasUnits',
    'trailingEnabled',
    'trailingActivationBps',
    'trailingDrawdownBps',
    'targetBuysAfterEntry',
  ]) {
    assert.match(html, new RegExp(field, 'u'));
  }
  assert.match(html, /exit-policy\/preview/u);
  assert.match(html, /method:\s*'PUT'/u);
  assert.match(html, /method:\s*'DELETE'/u);
  assert.match(html, /APPLY_EXIT_POLICY/u);
  assert.match(html, /RESET_EXIT_POLICY/u);
});
