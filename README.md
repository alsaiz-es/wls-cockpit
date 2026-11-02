# WLS Cockpit

A local operations cockpit for Oracle WebLogic Server, built on the WebLogic REST Management API.

## Why

Since WebLogic Server 14.1.2.0.0 the Administration Console is no longer part of the
product; Oracle's [release notes](https://docs.oracle.com/en/middleware/fusion-middleware/weblogic-server/14.1.2/notes/deprecated-removed-functionality.html)
point to the [WebLogic Remote Console](https://oracle.github.io/weblogic-remote-console/) for
the most similar experience. The Remote Console is the general-purpose console for
configuring and managing a domain.

WLS Cockpit does not replace it. It is a companion focused on day-to-day operation of a
running domain:

- **Domain dashboard** — server health, deployments in unexpected states, data sources under
  pressure and recent log errors on one screen.
- **Servers** — state, JVM heap and threads per server; start, shut down, suspend and resume
  several servers at once; stuck threads, thread dumps and live metrics per server; which servers
  need a restart to apply activated changes; turn common debug flags on and off on a running server.
- **Deployments** — state per target, start / stop / redeploy, deploy by uploading an archive
  from your machine or from an AdminServer-side path, undeploy and target management.
- **Data sources** — live pool statistics, test and reset pool, guided connection settings.
- **Logs** — a unified tail across servers with severity, server and text filters.
- **JMS** — servers and destinations inventory; optional message browse, detail, delete and
  produce over JMX (see [JMS over JMX](#optional-jms-over-jmx)).
- **Stores and SAF** — persistent store health, store-and-forward agents with their remote
  endpoints, and messaging bridge state.
- **JTA, JNDI, clusters, work managers and Node Manager** — runtime views and guarded actions.
- **Security** — user lockout counters per server, and clearing the lockout of a user.
- **Action audit** — lifecycle, deployment, data source, JMS, JTA and user lockout actions and
  every configuration change sent through Cockpit are recorded locally.
- **Config snapshots and local alerts** — capture and compare domain configuration, and raise
  local alerts from runtime signals.

## Screenshots

<!-- TODO screenshot: dashboard -->
<!-- TODO screenshot: servers -->
<!-- TODO screenshot: data sources -->
<!-- TODO screenshot: logs -->
<!-- TODO screenshot: JMS -->

## Quick start

Requires Node.js 20.11 or later on the workstation that runs Cockpit.

```bash
npx wls-cockpit
```

Cockpit opens in your default browser (`http://127.0.0.1:8080` by default; the URL is also
printed). Create a connection profile for your AdminServer and sign in with a WebLogic user.
Running the command again while Cockpit is up just opens the browser on the running instance.
Stop it with Ctrl+C or with **Quit** in the app header.

Without Node.js, download the portable archive for your platform from
[GitHub Releases](https://github.com/alsaiz-es/wls-cockpit/releases): on Windows unzip it and
double-click `WLS Cockpit.exe`; on macOS open the disk image and `WLS Cockpit.app`; see
[Portable builds](#portable-builds). Started this way, Cockpit stops when you close its last
browser tab (or with **Quit**). Cockpit talks to the AdminServer's
`/management/weblogic/<version>` REST endpoints with HTTP Basic authentication.

The safe way to try it against a real domain is read-only demo mode:

```bash
npx wls-cockpit --read-only-demo
# or
WLS_COCKPIT_READ_ONLY=1 npx wls-cockpit
```

Read-only demo mode hides mutation controls in the UI and masks sensitive display values. The
local server additionally refuses JMS delete and produce requests. It is a UI guard, not an
authorization boundary: the REST proxy itself still forwards whatever the browser sends. For a
hard guarantee, rely on WebLogic authorization and sign in with a user whose roles do not allow
changes, such as a `Monitor`-only user.

### Options

| Flag | Environment variable | Default | Description |
|---|---|---|---|
| `--target=<origin>` | `WLS_COCKPIT_TARGET` | none | AdminServer origin (for example `http://wls-admin.example.com:7001`) used to seed the first profile and as proxy fallback. Credentials, paths, queries and fragments are rejected. |
| `--host=<host>` | `WLS_COCKPIT_HOST` | `127.0.0.1` | Local bind address. |
| `--port=<port>` | `WLS_COCKPIT_PORT` | `8080` | Local bind port. `0` picks an ephemeral port. |
| `--version=<version>` | `WLS_COCKPIT_VERSION` | `14.1.2.0.0` | Default REST version for the seeded profile: `14.1.2.0.0` or `12.2.1.4.0`. |
| `--read-only-demo` | `WLS_COCKPIT_READ_ONLY` | off | Read-only demo mode (see above). |
| `--exit-with-last-tab` | `WLS_COCKPIT_EXIT_WITH_LAST_TAB` | off | Stop when the last browser tab with Cockpit closes, after a 10 s grace period. The double-click launchers use it. |
| `--open` / `--no-open` | `WLS_COCKPIT_OPEN` | auto | Open the browser once Cockpit is listening. By default it opens only when started from an interactive terminal, so scripts and services stay headless. |
| `--help` | | | Print usage. |

Usernames and passwords are never accepted on the command line: `--user`, `--username` and
`--password` are rejected on purpose.

## Security model

- **Loopback by default.** The server binds to `127.0.0.1` and has no authentication of its own.
  While bound to loopback it only answers requests whose `Host` is `localhost`, `127.0.0.1` or
  `[::1]` on its own port, so a web page that rebinds its hostname to `127.0.0.1` cannot use it.
  Anyone who can reach the port can use it as a proxy to any WebLogic origin (with their own
  WebLogic credentials) and read the stored profile catalog and audit log. Binding to another
  address with `--host` lifts the `Host` check and exposes all of that to the network; keep the
  default unless the network is trusted.
- **Passwords stay in the browser tab.** The password is entered in the login form and kept in
  the tab's `sessionStorage` for that session. Cockpit never writes it to the profile catalog,
  the audit log or `localStorage`, and the CLI does not accept it.
- **No lockout from polling.** WebLogic counts each request with a wrong password as a failed
  login. When the password of a session stops working (changed, expired or locked), the local
  server lets only one request reach WebLogic, refuses the rest locally until the next sign-in,
  and the browser signs out instead of polling on.
- **Same-origin proxy.** The browser only talks to the Cockpit origin. Requests to `/api/wls/*`
  are forwarded to the selected AdminServer with the browser's `Authorization` header; the
  upstream `WWW-Authenticate` header is dropped so the browser does not show its own
  credential prompt.
- **Local audit of mutations.** Mutating requests (lifecycle, deploy, configuration edits, JMS
  delete and produce, and similar) are appended to a local audit log with time, user, profile,
  target host, method, path and outcome. Secret-looking fields and query values are redacted.
  The log is shown on the Audit page.
- **Quit from the browser.** When Cockpit runs from the CLI, `POST /__wls-cockpit/shutdown` stops
  the local server. It requires a custom request header and a loopback `Host` that matches the
  listening port, so other web pages (including DNS-rebinding attempts) cannot stop it. Bound
  to one non-loopback address (`--host=<address>`), Quit is also accepted from pages opened at
  that address; bound to all interfaces (`--host=0.0.0.0`), only from loopback on the Cockpit
  machine.
- **Local data.** Connection profiles (name, target URL, REST version, optional username) and
  the audit log are stored under `~/.wls-cockpit/` (`connection-profiles.json`,
  `action-audit.jsonl`). Set `WLS_COCKPIT_DATA_DIR` to use another directory. The browser also
  keeps profiles, theme and config snapshots in `localStorage` for the Cockpit origin.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Supported WebLogic versions

| Version | Status |
|---|---|
| 12.2.1.4 | Tested against a live domain |
| 14.1.2 | Tested against a live domain |
| 14.1.1 | Not tested; its REST version is not selectable |
| 15.1.1 | Not tested; its REST version is not selectable |

## Portable builds

For workstations without Node.js or without npm access, `npm run package:portable:<platform>`
assembles a self-contained folder for Linux, macOS or Windows, optionally bundling a Node
runtime (required for Windows). Tagged releases attach Linux, Windows and macOS archives to
[GitHub Releases](https://github.com/alsaiz-es/wls-cockpit/releases).

The Windows and macOS releases start with a double-click (`WLS Cockpit.exe`, `WLS Cockpit.app`)
on `http://127.0.0.1:8888`, without a console window, and open the browser; stop Cockpit with
Quit in the app header. On macOS, releases
ship a disk image (`.dmg`) with `WLS Cockpit.app`, signed with the maintainer's Developer ID and
notarized by Apple: macOS only asks once to confirm that it was downloaded from the internet. A
portable folder you assemble yourself is unsigned: the first time, right-click
`WLS Cockpit.command` and choose **Open**. The Windows launcher is not code-signed: the first
time, SmartScreen shows "Windows protected your PC"; choose **More info**, then **Run anyway**.
`start-wls-cockpit.cmd` starts the same server in a console window that shows its log.
See [app/README.md](app/README.md#portable-runtime) for the details.

## Optional JMS over JMX

In the versions tested, the WebLogic REST API does not return JMS message rows, so message
browse, detail, delete and produce go through WebLogic's JMX/T3 client. This is optional and only enabled when the
Cockpit host has a JDK compatible with the domain (for example JDK 8 for 12.2.1.4) and the
WebLogic client jar `wlthint3client.jar`, found through `WLS_COCKPIT_WLS_CLIENT_CLASSPATH`,
`WLS_COCKPIT_WL_HOME`, `WL_HOME` or `ORACLE_HOME`. Cockpit does not distribute Oracle jars. See
[app/README.md](app/README.md#optional-jms-message-browsing).

The same client reads the JNDI tree on 12.2.1.4, whose REST API has no JNDI resource; on 14.1.x
JNDI comes from REST and needs nothing extra. With JDK 17 or later Cockpit starts the helper with
the `--add-opens` flags the thin client needs.

## Relationship with weblogic-rest-openapi

The typed REST client is generated from the OpenAPI specs published by
[weblogic-rest-openapi](https://github.com/alsaiz-es/weblogic-rest-openapi) (browsable reference at
[alsaiz-es.github.io/weblogic-rest-openapi](https://alsaiz-es.github.io/weblogic-rest-openapi/)).
Copies of the 14.1.2 and 12.2.1.4 specs are vendored in [openapi/](openapi/) and turned into
TypeScript types by `npm run gen`.

## Development

The application lives in `app/`. Building needs Node.js 20.19+ or 22.12+; the unit tests need
Node.js 22.6+.

```bash
cd app
npm install            # also generates the REST types from ../openapi
npm run dev            # Vite dev server with the WebLogic proxy
npm run test:unit
npm run lint
npx tsc -b --force
npm run build          # dist/ (UI) and dist-server/ (CLI and server)
```

For the development server, copy `app/.env.example` to `app/.env.local` and set
`VITE_WLS_TARGET` to your AdminServer. Contribution guidelines are in
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).

Not affiliated with, endorsed by, or supported by Oracle. Oracle and WebLogic are trademarks of
Oracle Corporation.
