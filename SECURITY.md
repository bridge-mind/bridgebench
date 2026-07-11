# Security policy

## Report privately

Use GitHub's private vulnerability reporting for this repository:

1. Open the repository's **Security** tab.
2. Select **Report a vulnerability**.
3. Include affected versions, reproduction steps, impact, and a proposed fix when available.

Do not include credentials, active hidden references, private task-pack paths, or builder data in a public issue.

## Scope

Security reports may cover:

- command or path injection;
- secret exposure in logs, errors, or browser state;
- hidden-reference disclosure;
- unsafe handling of model output;
- dashboard origin or host validation bypass;
- journal or published-result tampering;
- dependency and CI supply-chain issues.

Model quality disagreements and benchmark methodology proposals are not security vulnerabilities. Use the audit-report or feature-request issue forms instead.

## Response

Maintainers will acknowledge a private report, reproduce it, assess impact, and coordinate a fix before public disclosure. Timelines depend on severity and whether credentials or active task packs require rotation.

## Supported version

Security fixes target the current `main` branch and the latest published release.
