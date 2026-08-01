# PostgreSQL CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exécuter automatiquement la suite PostgreSQL dans le job GitHub Actions existant et documenter le même parcours de validation en local.

**Architecture:** Le job `validate` provisionne un service jetable PostgreSQL 16 avec healthcheck, transmet `TEST_DATABASE_URL`, puis exécute les quatre validations du dépôt dans un ordre déterministe. Un test de contrat lit le workflow comme du texte pour empêcher la suppression accidentelle du service, de l’URL de test ou de la commande d’intégration.

**Tech Stack:** GitHub Actions, PostgreSQL 16, Node.js 22, TypeScript ESM, `node:test`, npm.

---

### Task 1: Verrouiller le service PostgreSQL de la CI

**Files:**
- Create: `tests/ci-workflow.test.ts`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Écrire le test rouge du service PostgreSQL**

Créer `tests/ci-workflow.test.ts` avec :

```typescript
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(
  new URL('../.github/workflows/ci.yml', import.meta.url),
  'utf8',
);

test('la CI provisionne PostgreSQL 16 avec une URL de test locale', () => {
  assert.match(workflow, /services:\n\s+postgres:/u);
  assert.match(workflow, /image: postgres:16-alpine/u);
  assert.match(workflow, /POSTGRES_DB: bscbot/u);
  assert.match(workflow, /POSTGRES_USER: bscbot/u);
  assert.match(workflow, /POSTGRES_PASSWORD: bscbot/u);
  assert.match(workflow, /5432:5432/u);
  assert.match(workflow, /pg_isready -U bscbot -d bscbot/u);
  assert.match(
    workflow,
    /TEST_DATABASE_URL: postgresql:\/\/bscbot:bscbot@127\.0\.0\.1:5432\/bscbot/u,
  );
});
```

- [ ] **Step 2: Vérifier que le test échoue pour la bonne raison**

Run:

```bash
node --test --import tsx tests/ci-workflow.test.ts
```

Expected: FAIL sur l’absence de `services:\n  postgres:` dans le workflow actuel.

- [ ] **Step 3: Ajouter le service et l’environnement de test**

Remplacer `.github/workflows/ci.yml` par :

```yaml
name: CI

on:
  push:
  pull_request:

jobs:
  validate:
    runs-on: ubuntu-latest
    env:
      TEST_DATABASE_URL: postgresql://bscbot:bscbot@127.0.0.1:5432/bscbot
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_DB: bscbot
          POSTGRES_USER: bscbot
          POSTGRES_PASSWORD: bscbot
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U bscbot -d bscbot"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install
      - run: npm run check
      - run: npm test
      - run: npm run build
```

- [ ] **Step 4: Vérifier que le test passe**

Run:

```bash
node --test --import tsx tests/ci-workflow.test.ts
```

Expected: 1 test réussi, 0 échec.

- [ ] **Step 5: Committer le contrat du service PostgreSQL**

```bash
git add tests/ci-workflow.test.ts .github/workflows/ci.yml
git commit -m "ci: provision PostgreSQL integration service"
```

### Task 2: Exécuter toute la chaîne de validation en CI

**Files:**
- Modify: `tests/ci-workflow.test.ts`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Ajouter le test rouge de l’installation et de l’ordre des commandes**

Ajouter sous le premier test :

```typescript
test('la CI utilise npm ci et exécute les validations dans l’ordre', () => {
  const commands = [
    '- run: npm ci',
    '- run: npm run check',
    '- run: npm test',
    '- run: npm run test:postgres',
    '- run: npm run build',
  ];

  let previousIndex = -1;
  for (const command of commands) {
    const index = workflow.indexOf(command);
    assert.ok(index > previousIndex, `${command} doit suivre la commande précédente.`);
    previousIndex = index;
  }
  assert.doesNotMatch(workflow, /- run: npm install/u);
});
```

- [ ] **Step 2: Vérifier que le nouveau test échoue**

Run:

```bash
node --test --import tsx tests/ci-workflow.test.ts
```

Expected: FAIL car le workflow contient encore `npm install` et ne contient pas `npm run test:postgres`.

- [ ] **Step 3: Rendre l’installation et la validation déterministes**

Dans `.github/workflows/ci.yml`, remplacer :

```yaml
      - run: npm install
      - run: npm run check
      - run: npm test
      - run: npm run build
```

par :

```yaml
      - run: npm ci
      - run: npm run check
      - run: npm test
      - run: npm run test:postgres
      - run: npm run build
```

- [ ] **Step 4: Vérifier les deux contrats CI**

Run:

```bash
node --test --import tsx tests/ci-workflow.test.ts
```

Expected: 2 tests réussis, 0 échec.

- [ ] **Step 5: Committer la chaîne de validation**

```bash
git add tests/ci-workflow.test.ts .github/workflows/ci.yml
git commit -m "ci: run PostgreSQL integration tests"
```

### Task 3: Documenter la validation PostgreSQL locale et CI

**Files:**
- Modify: `README.md:344`

- [ ] **Step 1: Mettre à jour la section PostgreSQL du README**

Remplacer la section `## Tests PostgreSQL` jusqu’au paragraphe précédant
`Le serveur reste lié` par :

````markdown
## Tests PostgreSQL

La suite standard `npm test` ne nécessite pas PostgreSQL. La CI exécute aussi
la suite d’intégration PostgreSQL sur chaque push et pull request avec un
service PostgreSQL 16 jetable.

Pour reproduire cette validation localement, démarrer PostgreSQL puis fournir
explicitement une base de test :

```bash
docker compose up -d postgres
TEST_DATABASE_URL=postgresql://bscbot:bscbot@127.0.0.1:5432/bscbot \
  npm run test:postgres
```

Cette commande crée des schémas temporaires isolés, exécute les migrations
depuis une base vide puis une seconde fois pour vérifier leur idempotence,
valide la sérialisation exacte des `bigint` et les contraintes de
déduplication, puis supprime les schémas.

La validation complète avant commit reste :

```bash
npm run check
npm test
TEST_DATABASE_URL=postgresql://bscbot:bscbot@127.0.0.1:5432/bscbot \
  npm run test:postgres
npm run build
```
````

- [ ] **Step 2: Vérifier que la documentation ne contient aucun placeholder sensible**

Run:

```bash
if rg -n 'PRIVATE_KEY=0x[0-9a-fA-F]{64}|https?://[^ ]*(api[_-]?key|token)=' README.md .github/workflows/ci.yml; then
  exit 1
fi
```

Expected: aucune sortie, code 0.

- [ ] **Step 3: Vérifier la mise en forme du diff**

Run:

```bash
git diff --check
```

Expected: aucune sortie, code 0.

- [ ] **Step 4: Committer la documentation**

```bash
git add README.md
git commit -m "docs: explain PostgreSQL CI validation"
```

### Task 4: Valider le lot complet

**Files:**
- Verify: `.github/workflows/ci.yml`
- Verify: `tests/ci-workflow.test.ts`
- Verify: `README.md`

- [ ] **Step 1: Installer exactement les dépendances verrouillées**

Run:

```bash
npm ci
```

Expected: code 0 sans modification de `package-lock.json`.

- [ ] **Step 2: Démarrer et attendre PostgreSQL 16**

Run:

```bash
docker compose up -d postgres
docker compose exec -T postgres pg_isready -U bscbot -d bscbot
```

Expected: `accepting connections`.

- [ ] **Step 3: Exécuter les quatre validations de la CI**

Run:

```bash
npm run check
npm test
TEST_DATABASE_URL=postgresql://bscbot:bscbot@127.0.0.1:5432/bscbot npm run test:postgres
npm run build
```

Expected: toutes les commandes retournent le code 0 ; la suite standard et la
suite PostgreSQL ne contiennent aucun échec.

- [ ] **Step 4: Vérifier le workflow et l’état Git**

Run:

```bash
node --test --import tsx tests/ci-workflow.test.ts
git diff --check
git status --short
```

Expected: 2 tests de contrat réussis, aucun défaut de whitespace et uniquement
les modifications prévues ou aucun changement après les commits.
