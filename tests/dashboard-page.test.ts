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
  assert.match(html, /snapshot\.heartbeat\.latestBlock/);
  assert.match(html, /snapshot\.heartbeat\.activeSwapMonitors/);
  assert.match(html, /snapshot\.heartbeat\.http\.status/);
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
