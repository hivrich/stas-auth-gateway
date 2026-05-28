# Codex Validation

stas-auth-gateway is connected to the x4 Harness Control Plane.
Use this checklist before saying work is ready.

Validation must stay local and safe by default. No external writes are required for validation.

## Required Checks

- Harness files: confirm `AGENTS.md`, `.codex/config.toml`, and `docs/codex-validate.md` are present.
- Config: parse `.codex/config.toml` with Python `tomllib` when it changed.
- Diff hygiene: run `git diff --check` for files changed in the current task.
- Backend/auth checks: run local tests, typecheck, or static analysis when configured and relevant to the task.
- Local smoke: only without external writes, server changes, credential changes, auth changes, or production access.
- External-write dry run: confirm preview-only mode before running scripts that can change servers, auth, credentials, or remote state.
- Skipped checks: name every skipped check and the reason.

## Safety Stops

- External writes: no external writes without explicit user confirmation.
- Deploy/publish: no deploy, server changes, auth changes, gateway changes, or credential changes without explicit confirmation.
- Credentials/permissions: do not create, rotate, expose, or commit credentials, tokens, keys, OAuth config, or auth settings without explicit confirmation.
- Destructive/admin actions: no destructive server, auth, route, database, or remote-admin actions without explicit confirmation.

## Recommended Local Checks

- Unit tests when configured.
- Typecheck or static analysis when configured.
- Config/auth/permission diff review for any gateway-facing change.
- No secret values in logs, diffs, or reports.

## Notes

- Known skipped checks:
- Local runtime assumptions:
- Project-specific risks: auth gateway changes can affect access and credentials; keep checks local/preview-only unless the user explicitly approves a real change.
