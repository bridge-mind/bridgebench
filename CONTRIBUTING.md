# Contributing to BridgeBench

BridgeBench accepts code, task proposals, methodology audits, and documentation fixes.

## Before you start

- Read the [methodology](docs/methodology.md) before changing arena behavior.
- Read [task authoring](docs/task-authoring.md) before proposing benchmark content.
- Keep active hidden references out of issues, forks, commits, screenshots, and logs.
- Open an issue before changing methodology, journal formats, or rating behavior.

## Local setup

Use Node.js 20.19 or newer and npm 10 or newer.

```bash
npm ci
npx playwright install chromium
npm run check
```

The complete offline check requires no API key and no private overlay. Do not run paid arena commands as part of a pull request.

## Pull requests

Keep one concern per pull request. Include:

1. the behavior or documentation being changed;
2. the reason the change is needed;
3. tests for executable behavior;
4. compatibility notes for journal or methodology changes;
5. confirmation that `npm run check` passes.

Changes to deterministic scheduling must include a golden fixture. Changes to journals must include legacy parsing and tamper tests. Changes to public claims must cite the executable behavior that supports them.

## Propose a public task

1. Start from an existing public task in the same arena.
2. Keep every artifact and identity fictional.
3. Validate the individual file:

   ```bash
   npm run tasks -- validate --file tasks/reasoning/public/your-task.yaml
   ```

4. Open a task-proposal issue before changing the live 12-task pack.
5. Submit the public half only.

A task proposal does not need a private half. After the public task is accepted, a maintainer starts a private handoff through the GitHub account attached to the issue. Never post the expected resolution, trap inventory, or rubric in a public thread.

Replacing a live task requires a pack-rotation plan so cluster balance stays intact. Adding a thirteenth task directly to the live pack will fail validation.

## Audit a ladder

Download the published journal and run:

```bash
npm run arena -- verify --category reasoning --journal ./journal.jsonl
```

Use the audit-report issue form for reproducibility failures. Include the failing line number and verifier output; redact credentials and private paths.

## Report a security issue

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Style

- Prefer explicit names over abbreviations.
- Keep trust boundaries and invariants next to the code that enforces them.
- Use “builders” for the community and “agents” or “teammates” for AI systems.
- Avoid claims stronger than the implementation can prove.
