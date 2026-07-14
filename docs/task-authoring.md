# Task authoring

Every task is split into a **public half** (what competitors and everyone else sees, in this repo) and a **private half** (the hidden reference judges use, kept in the private overlay — see [private-packs.md](private-packs.md)). Both halves share a filename, ID, and version; the loader refuses mismatches.

## Domain invariant

**Every task is a coding / software-engineering scenario.** BridgeBench is a vibe-coding benchmark, so all artifacts are software artifacts — source code, diffs, git history, CI logs and configs, package manifests, API specs, database migrations, deploy records, service telemetry, AI-coding-agent sessions — and every deliverable is a question a coding agent would face. No generic business ops (invoices, staffing, org charts). All content is fictional: invented companies, services, and people only.

## Pack invariants (enforced by the loader and `npm run tasks -- validate`)

- Exactly **18 tasks per category**, **3 per cluster**, unique IDs.
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
| `category`         | `reasoning` \| `hallucination` \| `security` \| `bullshit` \| `refactoring` \| `debugging` \| `generation` \| `speed` |
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

## Security clusters

Every verdict must be derivable by reading the artifacts — no code is executed. Traps are internal to the material: benign look-alikes, false positives, unreachable sinks, and shallow patches sit next to the one real finding, and every task mixes confirmed vulnerabilities with "this is not a vulnerability" so over-flagging loses as clearly as missing. All systems are fictional; deliverables never request exploit code or payloads — reachability and precondition reasoning is the ceiling.

- **vuln-discovery** — a multi-file module hides one defensible vulnerability among attractive red herrings; one task per pack is crypto-misuse-themed (wrong primitive, mode, randomness, or JWT/alg handling as the planted flaw);
- **taint-flow** — trace user-controlled sources to sinks across files and services; decoy sinks are escaped, sanitized, unreachable, or not security sinks, and exactly one path is genuinely reachable-and-unsafe;
- **authz-boundary** — reconstruct guard/middleware chains, role checks, object scoping, and tenant isolation to decide which routes and objects are actually exposed, to whom, and which look exposed but are covered or intended;
- **patch-verification** — given a reported vulnerability and candidate fix diffs, decide which patches actually close it; plant shallow or wrong-context fixes that look sufficient and at least one minimal fix that looks insufficient but is correct;
- **finding-triage** — classify each finding in a fictional scanner report as true-positive or false-positive with evidence; roughly half must be false positives so blanket confirmation loses as clearly as dismissal;
- **supply-chain** — analyze lockfile, dependency, and CI/pipeline signals for tampering; one task per pack is secrets-exposure-themed (what leaked where across git history, CI logs, and Dockerfiles, and what is exploitable versus benign).

**Authoring rule:** the private half assigns every deliverable a verdict — _vulnerable_, _not-a-vulnerability / false-positive_, _unreachable_, _closes_, or _does-not-close_ — and every decoy you plant (each benign look-alike, sanitized sink, covered guard, and shallow patch) must appear verbatim in `disqualifyingErrors`. A confirmed finding is only defensible if the reachable source-to-sink or guard-bypass chain is derivable from `requiredEvidence` alone; where a verdict rests on absence or coverage (no other route, a sink never reached, a global guard the scanner can't see, a key never rotated), an artifact must self-declare that exhaustiveness so "not exploitable" is provable from the material. If a benign item can be honestly read as a vulnerability, the task is broken — fix the artifacts, not the rubric.

## BullShit clusters

Every task mixes legitimate, answerable deliverables with seeded nonsense, so playing along loses as clearly as blanket refusal. Nonsense must be provably nonsense from the artifacts alone — a spec, schema, or glossary in the task self-declares the real concepts, units, and causal relationships, so "this question is incoherent" is derivable from the material, never from outside knowledge:

- **fabricated-concepts** — deliverables invoke standards, algorithms, config keys, or protocol features that sound real but are never defined anywhere in the artifacts, next to near-miss twins that are;
- **crossed-domains** — deliverables conflate two incompatible domains (e.g. asking for the checksum of a latency, the schema of a thread pool, the TLS version of a database row);
- **impossible-quantities** — deliverables demand values with impossible units, dimensions, or magnitudes that the artifacts' own definitions rule out;
- **reversed-causality** — deliverables presuppose a cause-and-effect the artifacts show running the other way;
- **plausible-pseudoscience** — deliverables cite real terms wired into a bogus mechanism the artifacts contradict;
- **loaded-assumptions** — deliverables presuppose an event, entity, or decision the artifacts prove never happened.

**Authoring rule:** the private half classifies every deliverable as _legitimate_ or _nonsense_ (naming the exact nonsense technique and the artifact evidence that exposes it), and states the nearest legitimate question a strong answer should redirect to. Every seeded nonsense premise must appear in `disqualifyingErrors` phrased as the played-along conclusion (e.g. "invents a mechanism for the fabricated concept"), and "refuses or falsely flags a legitimate deliverable" must also be listed — discrimination is the skill under test. If a nonsense deliverable can be honestly answered from the artifacts, the task is broken — fix the artifacts, not the rubric.

## Refactoring clusters

Artifacts pair existing code with a transformation goal and candidate rewrites. Exactly one resolution preserves observable behavior while meeting the goal; every decoy changes behavior in a subtle, citable way or fails the goal. No code is executed — equivalence must be provable by reading across every affected path:

- **behavior-preservation** — candidate rewrites where one preserves observable behavior and decoys alter ordering, side-effect timing, error semantics, or an edge case;
- **extract-and-inline** — extractions/inlinings where the correct transform captures the right scope and evaluation order and decoys capture the wrong variable, break sharing, or reorder short-circuits;
- **dependency-decoupling** — decouplings that preserve initialization order and avoid cycles, versus decoys that introduce a cycle, change singleton sharing, or alter lifecycle timing;
- **api-migration** — call-site migrations that preserve semantics, versus decoys that mis-map an argument, drop a flag, or swap a default;
- **dead-code-elimination** — removals of only truly-unreachable code, provable from a self-declared set of entry points and flags, versus decoys that drop reachable code or keep dead code;
- **semantic-equivalence** — transforms that are equivalent under the language's semantics across a cited edge case (overflow, short-circuit, async ordering, null handling), versus ones that break on it.

**Authoring rule:** the private half classifies every deliverable with the verdict vocabulary (behavior-preserving / changes-behavior / meets-goal / fails-goal), and every decoy's observable difference appears in `disqualifyingErrors`. A "safe" verdict is defensible only if equivalence is traceable from the public artifacts across every path; absence-based verdicts need a public exhaustiveness declaration.

## Debugging clusters

Artifacts describe a failing system — logs, diffs, traces, tests, telemetry — among red-herring causes and shallow fixes. Exactly one root cause and one adequate fix are defensible; trace symptom to origin, not to where the error surfaces:

- **root-cause-isolation** — one defensible root cause among attractive red herrings, each ruled out with cited evidence;
- **regression-introduction** — a git history or ordered diffs where one change introduced the regression, provable by per-commit evidence;
- **concurrency-defect** — a race, deadlock, or ordering bug whose failing interleaving is provable from fully-visible synchronization;
- **state-corruption** — the first violated invariant versus downstream readers that merely observe already-bad state;
- **error-propagation** — the true origin of an error that surfaces far away, versus intermediate handlers that only pass it along;
- **fix-adequacy** — the candidate fix that resolves the cause without reintroducing a described regression, versus shallow fixes that mask the symptom.

**Authoring rule:** the private half classifies every deliverable (root-cause / red-herring / adequate-fix / shallow-fix), lists every red herring and shallow fix in `disqualifyingErrors`, and names "over-rejecting the correct minimal fix" where applicable. Rule-outs that rest on absence need a public exhaustiveness declaration (e.g. the complete set of writers of a field).

## Generation clusters

Artifacts pair a specification — its constraints, contracts, and edge cases — with candidate implementations or questions about a correct one. Exactly one resolution satisfies every stated requirement; decoys are plausible near-misses that violate a specific clause. Judge only against the stated spec:

- **spec-conformance** — the one candidate that conforms to every clause, versus decoys each violating a specific one;
- **edge-case-coverage** — the candidate that handles every required edge case the spec enumerates, versus ones that miss exactly one;
- **api-contract-adherence** — conformance to a declared contract (types, error codes, idempotency, ordering), versus decoys that break one term;
- **algorithmic-correctness** — the implementation that computes the specified function on all declared inputs, versus off-by-one or wrong-branch decoys;
- **constraint-satisfaction** — the implementation meeting declared non-functional constraints (complexity bound, no allocation, pure, single-pass), versus ones that violate one;
- **interface-compatibility** — drop-in compatibility with a declared interface or serialization, versus decoys that break it subtly.

**Authoring rule:** the specification artifact self-declares its complete constraint and edge-case set so "conforms" is provable. The private half classifies every deliverable (conforms / violates), names the exact clause and distinguishing input, and lists every near-miss in `disqualifyingErrors`. Deliverables classify and verify candidates rather than asking for free-form implementation — the arena is judged, not executed.

## Speed clusters

The Speed arena is not judged. Both models answer the same task and the faster completion wins; the engine records time-to-first-token and tokens-per-second and awards the win to the lower total completion time (an empty or failed response forfeits). Tasks are **public-only** — there is no hidden reference or private half. The six clusters vary the workload so latency is measured across regimes:

- **short-completion** — a small, well-scoped answer that stresses time-to-first-token;
- **long-generation** — a large output that stresses sustained throughput;
- **structured-output** — a schema-constrained response (JSON, table, diff);
- **code-transformation** — a mechanical rewrite of supplied code;
- **stepwise-reasoning** — a multi-step derivation with a definite endpoint;
- **retrieval-synthesis** — reading several artifacts and composing an answer.

**Authoring rule:** Speed tasks are realistic, fictional coding prompts that elicit comparable work from both models; they follow the public schema (no `expectedResolution`/rubric) and are validated with `npm run tasks -- validate --category speed`. Keep prompts unambiguous so neither model gains an unfair interpretation advantage — the arena measures latency, not who guessed the intent.

## Process

1. Author both halves locally (public in your fork, private in the overlay checkout).
2. `npm run tasks -- validate` until clean — with the overlay present it validates pairing and evidence; without it, the public schema and pack balance.
3. Bump `version` on any edit to either half; the journal hashes both, so silent drift is detectable.
4. External contributors: validate and propose the public half through the task-proposal issue form. Do not include a hidden reference.
5. After a public task is accepted, a maintainer starts a private handoff through the GitHub account attached to the issue. The private half never appears in the public issue or pull request.
6. Replacing a live task requires a pack-rotation plan that preserves the 18-task, three-per-cluster invariant.
7. Private halves are published when their pack retires (see [private-packs.md](private-packs.md)).
