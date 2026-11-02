# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/alsaiz-es/wls-cockpit/security/advisories/new)
("Report a vulnerability" in the repository's Security tab). Do not open a public issue.

Include the Cockpit version, the WebLogic version, how Cockpit was started (flags and relevant
environment variables, without secrets) and the steps to reproduce. Redact hostnames, IP
addresses, usernames and passwords from logs and screenshots.

This is a personal open source project: reports are handled on a best-effort basis, and fixes
land on the latest release only.

## Security model in short

- The local server binds to `127.0.0.1` by default and has no authentication of its own. While
  bound to loopback it only answers requests whose `Host` is `localhost`, `127.0.0.1` or `[::1]`
  on its port (a DNS-rebinding guard); it does not check `Origin`. Whoever can reach the port can
  use the proxy and read the stored profiles and audit log. Binding to another address with
  `--host` drops the `Host` check and is at your own risk.
- WebLogic passwords are entered in the browser, kept in the tab's `sessionStorage` and never
  written by Cockpit to disk or `localStorage`. The CLI rejects username and password options.
- The browser only talks to the Cockpit origin; `/api/wls/*` is forwarded to the selected
  AdminServer with the browser's `Authorization` header. Request bodies are capped (8 MiB for the
  proxy, 1 MiB for the local JSON endpoints) and larger ones are refused with HTTP 413.
- Mutating requests are recorded in a local audit log with secret-looking values redacted.
- Profiles and the audit log live under `~/.wls-cockpit/`, or `WLS_COCKPIT_DATA_DIR` when set.
- Read-only demo mode (`--read-only-demo`) is a UI guard, not an authorization boundary. Use
  WebLogic roles to restrict what a user can change.

See the [README](README.md#security-model) for the full description.
