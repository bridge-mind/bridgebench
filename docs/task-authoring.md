# Authoring UI Bench tasks

A task is two files: a **public spec** (this repo) and a **private probe
overlay** (bridgebench-private, hidden while the season is live).

## Public spec — `tasks/current/ui/s<season>-<slug>.yaml`

```yaml
id: s1-lava-lamp-redux          # season-prefixed kebab-case (enforced)
season: 1
title: Lava Lamp Redux
category: simulation            # simulation | interactive | game | typography
requiresWebGL: true
viewport: { width: 1280, height: 800 }
libraries: { three: "0.182.0" } # must match the season pin in src/config.ts
controls:                       # the public interaction contract
  - id: heat-slider             # artifact must set data-bb-control="heat-slider"
    kind: slider                # button | slider | canvas
    label: Heat
    behavior: "What it must do, precisely enough to probe, vague enough not to leak the probe."
screenshots:                    # gallery + scoring captures (ms after settle)
  - { at: 0, name: hero }
  - { at: 2500, name: motion }
prompt: |
  The creative brief. Be vivid about the look; be exact about the controls.
```

Rules of thumb:

- **Declare every control** you intend to probe, with a `data-bb-control`
  id. Probes target those selectors (or canvas-relative coordinates for
  pointer choreography on `scene-canvas`).
- **No external assets ever** — textures must be procedural; text must be
  rendered to an offscreen canvas, never loaded as a font file (artifact CSP
  has `connect-src 'none'`).
- **Idle motion matters**: the motion dimension samples the untouched scene.
  A scene that's static until interaction (e.g. a puzzle) must be given
  gentle idle drift in the prompt, or a `motionMinChangedPct` override in
  its probe overlay.
- Public task files must NOT contain a `probes:` key — the loader refuses
  them, and CI greps for leaks.

## Private overlay — `bridgebench-private/tasks/current/ui/<id>.probes.yaml`

```yaml
id: s1-lava-lamp-redux
probes:
  - id: heat-slider-drives-motion
    weight: 2                   # relative importance in the probes-passed badge
    steps:                      # real input, executed in order
      - { action: reset, seed: 7 }
      - { action: setSlider, selector: "[data-bb-control='heat-slider']", fraction: 0 }
      - { action: waitMs, ms: 1200 }
      - { action: snapshot, name: slow-a }
      # … see src/suites/ui/types.ts for the full step + assert DSL
    asserts:
      - anyOf:
          - { type: motionIncreased, slowA: slow-a, slowB: slow-b, fastA: fast-a, fastB: fast-b, minFactor: 1.6 }
          - { type: stateChangedVs, ref: s-low, path: heat }
scoringOverrides:
  motionMinChangedPct: 0.4      # slow scenes need a lower animation threshold
```

Probe design principles:

- **Measure causation, not coincidence.** Animated scenes change pixels on
  their own, so a bare `pixelDeltaVs` across a control change passes
  trivially. Prefer `motionIncreased` (delta-of-deltas), `luminanceRatioVs`,
  `hueShiftVs`, and `stateChangedVs`.
- **Always include a `state-contract` probe**: `getState()` must be
  JSON-serializable and time-stable (`stateUnchangedVs` after a 500ms wait).
  The artifact contract promises both.
- **Weight what matters.** Probe results surface as a "verified interactive"
  badge beside the artifact (they inform voters, never the ranking); give the
  task's signature interaction the highest weight.
- Probes run sequentially on the SAME page — start with `reset` when a probe
  needs a known state.

## Checklist for a new task

1. Public YAML parses: `npm run ui -- tasks`.
2. Hand-write a quick reference artifact and grade it:
   `npm run ui -- evaluate my-reference.html -t <id>` — the reference should
   QUALIFY with all probes passing; a deliberately broken variant should be
   disqualified.
3. Probe thresholds hold under SwiftShader (slow frames): generous waits,
   conservative pixel thresholds.
4. No probe details leak into the public prompt.
