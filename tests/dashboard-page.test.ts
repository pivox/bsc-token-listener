import assert from 'node:assert/strict';
import test from 'node:test';
import { injectControls } from '../src/dashboard/action-dashboard.js';
import { renderDashboardPage } from '../src/dashboard/dashboard.page.js';

test('dashboard affiche les champs heartbeat dans la page', () => {
  const html = renderDashboardPage('nonce', 5);
  assert.match(html, /id="heartbeat-latest-block"/);
  assert.match(html, /id="heartbeat-pair-created"/);
  assert.match(html, /id="heartbeat-swap-monitors"/);
  assert.match(html, /id="heartbeat-active-sessions"/);
  assert.match(html, /id="heartbeat-http-status"/);
  assert.match(html, /id="heartbeat-ws-status"/);
  assert.match(html, /id="recovery-pending-sessions"/);
  assert.match(html, /id="recovery-manual-review"/);
  assert.match(html, /id="recovery-last-completed"/);
  assert.match(html, /snapshot\.heartbeat\.latestBlock/);
  assert.match(html, /snapshot\.heartbeat\.monitoring\.activeMonitors/);
  assert.match(html, /snapshot\.heartbeat\.monitoring\.capacity/);
  assert.match(html, /snapshot\.heartbeat\.monitoring\.waitingSessions/);
  assert.match(html, /snapshot\.heartbeat\.monitoring\.abandonedSessions/);
  assert.match(html, /snapshot\.heartbeat\.monitoring\.oldestWaitingAgeMs/);
  assert.match(html, /snapshot\.heartbeat\.http\.status/);
  assert.match(html, /snapshot\.heartbeat\.recovery\.pendingSessions/);
  assert.match(html, /id="chain-confirmed-head"/);
  assert.match(html, /id="chain-canonical-tip"/);
  assert.match(html, /id="chain-state"/);
  assert.match(html, /id="chain-last-reorg"/);
  assert.match(html, /chain\.confirmedHead/);
  assert.match(html, /chain\.canonicalBlockHash/);
  assert.match(html, /chain\.lastReorg/);
  assert.match(html, /chain\.state/);
  assert.match(html, /id="rpc-usage-total"/);
  assert.match(html, /id="rpc-usage-budget"/);
  assert.match(html, /id="rpc-usage-retries"/);
  assert.match(html, /snapshot\.heartbeat\.rpcUsage/);
});

test('dashboard affiche l’entrée à la seconde et le lien Dexscreener de la paire', () => {
  const html = renderDashboardPage('nonce', 5);
  assert.match(html, /<th>Entrée<\/th>/u);
  assert.match(html, /formatDate\(token\.entry\.confirmedAt\)/u);
  assert.match(html, /https:\/\/dexscreener\.com\/bsc\/' \+ token\.pairAddress/u);
  assert.match(html, /allowedHosts = \['bscscan\.com', 'testnet\.bscscan\.com', 'dexscreener\.com'\]/u);
});

test('dashboard distingue PnL brut, gas, PnL net et simulation', () => {
  const html = renderDashboardPage('nonce', 5);
  assert.match(html, /PnL brut/u);
  assert.match(html, /Gas total/u);
  assert.match(html, /PnL net/u);
  assert.match(html, /Simulation/u);
  assert.match(html, /realizedGrossBnb/u);
  assert.match(html, /realizedNetBnb/u);
  assert.match(html, /gasBnb/u);
});

test('dashboard utilise la décision serveur pour afficher la vente', () => {
  const html = injectControls(renderDashboardPage('nonce', 5), 'nonce', 60);

  assert.match(html, /token\.canSell/u);
  assert.match(html, /finally\s*\{\s*try\s*\{\s*await Promise\.all/u);
});

test('dashboard affiche la surveillance de sortie d’une position', () => {
  const html = renderDashboardPage('nonce', 5);
  assert.match(html, /Prochaine évaluation/u);
  assert.match(html, /Durée restante/u);
  assert.match(html, /Stop-loss/u);
  assert.match(html, /Take-profit/u);
  assert.match(html, /lastProbeStatus/u);
  assert.match(html, /economicPnlPercent/u);
});
