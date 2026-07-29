# Reset runtime database design

## Goal

Provide a safe command to reset the bot's runtime state after `npm run dev` has
been stopped, while preserving the database schema and operator configuration.

## Command

Add `npm run db:reset-runtime -- --yes`.

The command must refuse to run without `--yes`, and must refuse to run when a
`tsx watch src/app.ts` process is still detected. The command uses the existing
`DATABASE_URL` configuration and does not read, print, or modify private keys.

## Data scope

Within one PostgreSQL transaction, delete runtime data in foreign-key-safe
order:

- `trade_transactions`, `trades`;
- `position_exit_decisions`, `reconciliation_decisions`;
- `token_risk_reports`, `swap_events`, `discovered_tokens`, `token_sessions`;
- `canonical_blocks`, `chain_reorgs`, `listener_checkpoints`,
  `fresh_start_runs`.

Keep `schema_migrations`, `runtime_settings`, `strategy_settings`,
`strategy_settings_audit`, and `ignored_assets`.

The command reports deleted row counts and rolls back the complete transaction
if any deletion fails.

## Testing

Add focused tests for confirmation/process guards and the deletion order/query
set. Run the repository validation commands before declaring completion:

```bash
npm run check
npm test
npm run build
```
