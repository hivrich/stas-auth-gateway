# Validation

Generated target path: `docs/codex-validate.md`.

Record project-specific checks here. Keep them concrete, local, and safe by default.

## Required Checks

- Syntax/config:
- Lint/typecheck:
- Tests:
- Build:
- Browser/UI smoke:
- External-write dry run: confirm preview-only mode before running scripts that can change servers, auth, credentials, or remote state.

## Safety Stops

- External writes: no external writes without explicit user confirmation.
- Deploy/publish: no deploy, server changes, auth changes, gateway changes, or credential changes without explicit confirmation.
- Credentials/permissions: do not create, rotate, expose, or commit credentials, tokens, keys, OAuth config, or auth settings without explicit confirmation.
- Destructive/admin actions: no destructive server, auth, route, database, or remote-admin actions without explicit confirmation.

## Notes

- Known skipped checks:
- Local runtime assumptions:
- Project-specific risks: auth gateway changes can affect access and credentials; keep checks local/preview-only unless the user explicitly approves a real change.
