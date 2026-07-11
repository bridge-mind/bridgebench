# Task authoring

Every task is split into a **public half** (what competitors and everyone else sees, in this repo) and a **private half** (the hidden reference judges use, kept in the private overlay — see [private-packs.md](private-packs.md)). Both halves share a filename, ID, and version; the loader refuses mismatches.

## Domain invariant

**Every task is a coding / software-engineering scenario.** BridgeBench is a vibe-coding benchmark, so all artifacts are software artifacts — source code, diffs, git history, CI logs and configs, package manifests, API specs, database migrations, deploy records, service telemetry, AI-coding-agent sessions — and every deliverable is a question a coding agent would face. No generic business ops (invoices, staffing, org charts). All content is fictional: invented companies, services, and people only.

## Pack invariants (enforced by the loader and `npm run tasks -- validate`)

- Exactly **12 tasks per category**, **2 per cluster**, unique IDs.
- Public and private halves must agree on `id` and `version`.
- Every `requiredEvidence` entry in the private half must name an existing public artifact ID.
- Public artifact IDs must be unique and the YAML filename must match the task ID.
- Rendered competitor and worst-case judge payloads must fit the engine's prompt budget.
- A task's `category` must match its pack directory and its `cluster` must belong to that category.

Use `npm run tasks -- validate --file <path>` to validate one proposed public task without enforcing full-pack balance.

## Public half schema (`tasks/<category>/public/<id>.yaml`)

| Field              | Constraints                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `id`               | kebab-case, regex-validated                                                                     |
| `version`          | semver; bump on any content change (hashes are journaled)                                       |
| `category`         | `reasoning` \| `hallucination`                                                                  |
| `cluster`          | one of the category's six clusters (below)                                                      |
| `difficulty`       | `hard` \| `expert` (current packs are all `expert`)                                             |
| `title`, `summary` | summary ≤ 500 chars                                                                             |
| `prompt`           | ≤ 10k chars — the numbered deliverables live here                                               |
| `artifacts[]`      | 1–20 of `{id, type, label, content ≤ 40k}`; `type` ∈ code, log, config, spec, diff, table, note |
| `tags[]`           | optional, ≤ 60 chars each                                                                       |

Tasks are deliberately heavyweight: five to eight interlocking artifacts (~9–18k characters) and four to ten numbered deliverables, so a match exercises real deliberation budget instead of a one-screen skim.

## Private half schema (overlay: `tasks/<category>/private/<id>.yaml`)

| Field                   | Purpose                                                              |
| ----------------------- | -------------------------------------------------------------------- |
| `id`, `version`         | must match the public half                                           |
| `expectedResolution`    | ≤ 10k prose — the defensible resolution for every deliverable        |
| `requiredEvidence[]`    | public artifact IDs a strong answer must ground itself in            |
| `disqualifyingErrors[]` | the planted decoy conclusions, named explicitly                      |
| `rubric`                | `{correctness, evidenceGrounding, constraintHandling, completeness}` |

## Reasoning clusters

Fully determinable; decoy paths planted and listed as disqualifying errors in the hidden reference:

- **stateful-execution** — trace state through interleaved operations;
- **constraint-reconciliation** — many constraints, one consistent assignment;
- **root-cause-reasoning** — the incident has one defensible root cause and several attractive red herrings;
- **multi-artifact-synthesis** — the answer only exists across artifacts, never inside one;
- **formal-counterexample** — find the input/schedule that breaks the claimed property;
- **uncertainty-adversarial** — noisy signals, but one best-supported conclusion.

**Authoring rule:** every decoy you plant must appear in `disqualifyingErrors`, and the true chain must be derivable from `requiredEvidence` alone. If two resolutions survive honest scrutiny, the task is broken — fix the artifacts, not the rubric.

## Hallucination clusters

Traps are internal to the artifacts, so ground truth stays verifiable; every task mixes supported deliverables with traps so blanket refusal loses as clearly as fabrication:

- **false-premise** — deliverables embed claims the artifacts contradict; the premise must be corrected with citations;
- **missing-evidence** — the key fact is deliberately absent while tempting near-substitutes exist;
- **entity-fabrication** — plausible endpoints, functions, tools, files, or config keys that are never defined, next to near-miss twins that are;
- **knowledge-boundary** — audit-style question sets where roughly half the items are determinable and half are not;
- **conflicting-sources** — artifacts disagree; silent blending or unacknowledged picking is the failure;
- **citation-fidelity** — exact values, quotes, and attributions under dense near-duplicate detail.

**Authoring rule:** the private half classifies every deliverable as _supported_, _false-premise_, or _not-determinable_, with the full trap inventory. Where a task tests absence (entity fabrication, missing evidence), an artifact should self-declare exhaustiveness (e.g. a spec that states it lists the complete API surface), so "doesn't exist" is provable from the material.

## Process

1. Author both halves locally (public in your fork, private in the overlay checkout).
2. `npm run tasks -- validate` until clean — with the overlay present it validates pairing and evidence; without it, the public schema and pack balance.
3. Bump `version` on any edit to either half; the journal hashes both, so silent drift is detectable.
4. External contributors: validate and propose the public half through the task-proposal issue form. Do not include a hidden reference.
5. After a public task is accepted, a maintainer starts a private handoff through the GitHub account attached to the issue. The private half never appears in the public issue or pull request.
6. Replacing a live task requires a pack-rotation plan that preserves the 12-task, two-per-cluster invariant.
7. Private halves are published when their pack retires (see [private-packs.md](private-packs.md)).
