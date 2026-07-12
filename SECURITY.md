# Security Policy

## Supported Versions

Recensa is pre-1.0 and ships fixes on the latest release only.

| Version  | Supported          |
| -------- | ------------------ |
| latest   | :white_check_mark: |
| < latest | :x: (please update)|

## Reporting a Vulnerability

Please report security issues **privately** via GitHub Security Advisories:

> `https://github.com/S40911120/recensa/security/advisories/new`

Do **not** open a public issue or discuss the vulnerability in public until it has
been addressed. You can expect an initial response within a few days.

## Scope

Recensa is a **local, self-hosted tool**. By default it binds `127.0.0.1` only and
enforces a Host/Origin allowlist (DNS-rebinding protection). Mutating requests
(POST/PUT/DELETE/PATCH) additionally require an allowlisted `Origin` header, which blocks
cross-origin CSRF writes against the local server; GET/HEAD are unaffected. It makes no
external network calls and collects no telemetry. Please keep this threat model in mind when
reporting — issues that require an attacker to already have local shell access, or
that stem from a user deliberately exposing the port to an untrusted network, are
generally out of scope.
