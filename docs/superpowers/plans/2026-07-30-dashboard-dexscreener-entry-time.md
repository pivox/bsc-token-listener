# Dashboard Dexscreener and Entry Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Dexscreener link for each pair and show the bot-confirmed entry date and time to the second in the main dashboard table.

**Architecture:** Reuse the existing `pairAddress` and `entry.confirmedAt` fields already exposed by the dashboard API. Update only the server-rendered dashboard HTML/JavaScript; no database migration or API shape change is required.

**Tech Stack:** TypeScript, ESM, inline dashboard HTML/JavaScript, Node test runner.

---

### Task 1: Extend the main dashboard table

**Files:**
- Modify: `src/dashboard/dashboard.page.ts`
- Test: `tests/dashboard-page.test.ts`

- [x] Add an `Entrée` column that renders `token.entry.confirmedAt` with the existing `formatDate` formatter, which includes seconds, and renders `—` when no entry exists.
- [x] Add a `Dexscreener` external link using `https://dexscreener.com/bsc/` plus `token.pairAddress`, guarded by the existing safe-link behavior and opened with `target="_blank"` and `rel="noopener noreferrer"`.
- [x] Keep the existing `Voir` details button and preserve the table’s empty-entry behavior.
- [x] Extend the dashboard page test to assert the new column labels and link-related rendering markers.
- [x] Run `npm test -- --test-name-pattern=dashboard-page` and then the full validation commands from `AGENTS.md`.
