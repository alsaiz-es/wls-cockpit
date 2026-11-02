# Contributing

Thanks for your interest in WLS Cockpit. Issues and pull requests are welcome.

## Requirements

- Node.js 22.6 or later for development. The unit tests use `--experimental-strip-types`, which
  Node.js 20 does not have; lint, type checking and the build also work on Node.js 20.19+.
  The published CLI declares `node >=20.11`.
- A WebLogic domain (12.2.1.4 or 14.1.2) for anything that touches the UI or the REST calls.

## Setup and checks

The application lives in `app/`. `npm install` also generates the REST types from the specs in
`openapi/`.

```bash
cd app
npm install
npm run test:unit
npm run lint
npx tsc -b --force
npm run build
```

All four checks must pass before a pull request is merged; CI runs them on every push and pull
request.

## Testing against WebLogic

Changes are tested against a real domain or in read-only mode:

- Run `npm run dev` with `app/.env.local` pointing `VITE_WLS_TARGET` at your AdminServer (start
  from `app/.env.example`), or run the built CLI with `--read-only-demo`.
- Use a disposable or lab domain for anything that mutates state (lifecycle, deployments, JMS
  delete and produce, configuration edits).
- `npm run smoke:visual:readonly` runs the read-only browser smoke checks; see
  [app/README.md](app/README.md#visual-smoke) for its variables.

## Keep lab data out of the repository

Never commit real hostnames, IP addresses, usernames, passwords, domain paths or captured
payloads. Use `wls-admin.example.com`, `127.0.0.1` and obvious placeholders in code, fixtures and
docs. `app/.env.local` and other local environment files are gitignored; keep them that way.

## Project workflow

Keep pull requests small and focused, with tests for behavioural changes. For anything larger
than a fix, open an issue first to agree on the approach. [AGENTS.md](AGENTS.md) lists the
principles each change must respect and the test that guards each one; UI work follows
[docs/ui/guidelines.md](docs/ui/guidelines.md).

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
