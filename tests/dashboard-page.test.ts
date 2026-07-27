import assert from 'node:assert/strict';
import test from 'node:test';
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
