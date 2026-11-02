# WLS Cockpit

A local operations cockpit for Oracle WebLogic Server, built on the WebLogic REST Management API. The packaged app serves the static UI and a same-origin proxy for WebLogic REST.

The [project README](https://github.com/alsaiz-es/wls-cockpit#readme) covers what Cockpit does, its security model and the supported WebLogic versions. This file is the package and runtime reference.

## Run From A Package

```bash
npx wls-cockpit
```

Cockpit opens in the default browser when started from an interactive terminal; the local URL is also printed. If Cockpit is already running on the chosen port, the command opens the browser on that instance and exits. Stop it with Ctrl+C or with Quit in the app header. Create one or more domain connection profiles in the browser. Self-hosted runs persist the profile catalog under the local Cockpit data directory so profiles survive restart and `--port=0` port changes. The browser also keeps a local cache for the active origin. Passwords are entered per browser tab session and are not written to the profile catalog.

Options:

- `--target=<origin>`: optional WebLogic AdminServer origin used as a first-run default profile seed and proxy fallback.
- `--host=<bind-host>`: local bind address. Defaults to `127.0.0.1`.
- `--port=<port>`: local bind port. Defaults to `8080`; use `0` for an ephemeral port.
- `--version=<wls-rest-version>`: default WLS REST version for initial profile seeding (`14.1.2.0.0` or `12.2.1.4.0`).
- `--open` / `--no-open`: open the default browser once Cockpit is listening, or never. Without either flag the browser opens only when stdout is an interactive terminal. `WLS_COCKPIT_OPEN=1` or `0` does the same.
- `--read-only-demo`: hide mutation controls and mask sensitive display values. The local server also refuses JMS delete and produce requests; other REST requests are still proxied, so this is not an authorization boundary. `WLS_COCKPIT_READ_ONLY=1` does the same.

Each option also has an environment variable: `WLS_COCKPIT_TARGET`, `WLS_COCKPIT_HOST`, `WLS_COCKPIT_PORT`, `WLS_COCKPIT_VERSION`.

Set `WLS_COCKPIT_DATA_DIR` to choose where local profile and audit data are stored. By default, Cockpit uses `.wls-cockpit` under the current user's home directory.

Seed a first profile explicitly when useful:

```bash
npx wls-cockpit --target=http://wls-admin.example.com:7001
```

Do not pass usernames or passwords to the CLI. Credentials are entered in the browser login form and remain scoped to the active browser tab session.

## Portable Runtime

Build the production assets first, then assemble a portable folder:

```bash
npm run build
npm run package:portable:linux
```

The Linux artifact is written under `portable/wls-cockpit-linux-x64/` and starts with:

```bash
./portable/wls-cockpit-linux-x64/start-wls-cockpit.sh
```

For macOS, provide a macOS Node runtime directory when the target workstation should not need a global Node installation:

```bash
npm run build
WLS_COCKPIT_NODE_RUNTIME_DIR=/path/to/node-vXX.YY.Z-darwin-arm64 npm run package:portable:macos
```

The macOS artifact is written under `portable/wls-cockpit-macos-arm64/` on Apple Silicon hosts. Double-click `WLS Cockpit.command` to start it on `http://127.0.0.1:8888` in a Terminal window and open the browser, or run `start-wls-cockpit.sh` with your own options. A folder assembled this way is not code-signed: the first time, right-click `WLS Cockpit.command` and choose Open, or clear the quarantine flag with `xattr -dr com.apple.quarantine <folder>`. To sign it and pack it into a disk image, notarized when Apple credentials are set, run `scripts/sign-macos-portable.sh <folder> <output.dmg>` on macOS with `MACOS_SIGNING_IDENTITY` (and `NOTARY_KEYCHAIN_PROFILE` to notarize); for a release, the maintainer runs `scripts/release-macos-portable.sh <tag>` on a Mac with Xcode, the Developer ID certificate and a `notarytool` keychain profile. It builds `WLS Cockpit.app` (`scripts/build-macos-app.mjs`: a native launcher from `scripts/macos/launcher.c`, the official Node binary and the app, since notarization only covers native code), signs and notarizes a disk image with it, and replaces the unsigned zip that CI attaches.

For Windows workstations without Node installed, supply a Node runtime directory at build time. The runtime is copied into the portable folder so the target workstation does not need a global Node installation:

```bash
npm run build
WLS_COCKPIT_NODE_RUNTIME_DIR=/path/to/node-win-x64 npm run package:portable:windows
```

The Windows artifact is written under `portable/wls-cockpit-windows-x64/`. Pass `--windows-launcher=<WLS Cockpit.exe>` (built with `node scripts/build-windows-launcher.mjs --out=...`, which needs mingw-w64) to include the double-click launcher: it starts Cockpit on `http://127.0.0.1:8888` without a console window, opens the browser, and reports a startup failure in a dialog; releases include it. `start-wls-cockpit.cmd` is always there and starts Cockpit without a default target at `http://127.0.0.1:8888` and opens that URL in the default browser; if Cockpit is already running there, it only opens the browser. The command window closes when Cockpit is stopped with Quit and stays open with the exit code if Cockpit fails.

### Deploying By Upload

The deploy form on the Deployments page can upload a `.war`, `.ear`, `.jar` or `.rar` (up to 2 GiB) from the workstation. The browser posts the raw archive to the local server (`POST /api/deployments/upload?version=<wls-rest-version>`, with the deployment name and targets in the `X-WLS-Cockpit-Deployment-Model` header and the file name in `X-WLS-Cockpit-File-Name`; the custom headers also make browsers send a CORS preflight, so other web pages cannot post there). The server streams it to WebLogic as the multipart `POST /management/weblogic/<version>/edit/appDeployments` without holding the archive in memory, inside an edit session that it activates. The upload is recorded in the action audit and refused in read-only demo mode. WebLogic keeps the uploaded file under the AdminServer's upload directory; targets on another host that use the `nostage` staging mode may not be able to read it from there.

### Optional JMS Message Browsing

JMS message browse/detail/delete/produce operations use WebLogic's standard JMX/T3 client when configured. On WebLogic 12.2.1.4 the same client also reads the JNDI tree (`POST /api/jndi/bindings`, read-only), because that release has no JNDI resource in its REST API. Provide WebLogic client jars from the same WebLogic version as the target domain:

```bash
WLS_COCKPIT_WLS_CLIENT_CLASSPATH=/opt/weblogic/wlserver/server/lib/wlthint3client.jar \
WLS_COCKPIT_JAVA_COMMAND=/opt/jdk8/bin/java \
WLS_COCKPIT_JAVAC_COMMAND=/opt/jdk8/bin/javac \
npx wls-cockpit
```

If Cockpit runs locally on a WebLogic host, discovery also accepts `WLS_COCKPIT_WL_HOME`, `WL_HOME`, or `ORACLE_HOME` when they identify a local `wlthint3client.jar`:

```bash
ORACLE_HOME=/opt/oracle/middleware \
WLS_COCKPIT_JAVA_COMMAND=/opt/jdk8/bin/java \
WLS_COCKPIT_JAVAC_COMMAND=/opt/jdk8/bin/javac \
./portable/wls-cockpit-linux-x64/start-wls-cockpit.sh
```

Use the JDK supported by that WebLogic installation, for example JDK 8 for 12.2.1.4 domains. If the helper runs on the same host as WebLogic, prefer the domain's installed JDK and client jar paths. Cockpit does not bundle Oracle jars.

## Development

```bash
npm install
npm run dev
```

The development server uses Vite and the same target validation rules as the packaged proxy.

## Build And Verify

```bash
npm run test:unit
npm run lint
npx tsc -b --force
npm run build
npm pack --dry-run
```

`npm run build` emits the browser bundle under `dist/` and the self-hosted CLI/server bundle under `dist-server/`.

## Visual Smoke

`npm run smoke:visual` defaults to the read-only profile. It exercises registered read-only route, detail, URL-state, and diagnostic checks against `WLS_SMOKE_APP_URL` and the configured WebLogic target.

```bash
WLS_SMOKE_PASSWORD=<password> npm run smoke:visual
WLS_SMOKE_PASSWORD=<password> WLS_SMOKE_CHECKS=log-details-live npm run smoke:visual:readonly
WLS_SMOKE_PASSWORD=<password> WLS_SMOKE_PROFILE=lifecycle WLS_SMOKE_CHECKS=servers-lifecycle npm run smoke:visual
```

For a 12.2.1.4 domain without the demo application or datasource, run only the portable compatibility checks:

```bash
WLS_SMOKE_APP_URL=http://localhost:5173 \
WLS_SMOKE_TARGET=http://wls-admin.example.com:7001 \
WLS_SMOKE_VERSION=12.2.1.4.0 \
WLS_SMOKE_PROFILE=readonly \
WLS_SMOKE_CHECKS=compat-dashboard-live,compat-servers-live,compat-server-details-admin,compat-deployments-live,compat-data-sources-live,compat-logs-live,compat-log-details-admin \
WLS_SMOKE_USERNAME=<username> \
WLS_SMOKE_PASSWORD=<password> \
npm run smoke:visual:readonly
```

The JNDI check (`jndi-safe-binding-live`) opens a binding of the AdminServer, by default the demo data source `jdbc/WLSCockpitDemoDS`; set `WLS_SMOKE_JNDI_BINDING` (for example `jdbc/SOADataSource`) for a domain without it. On 12.2.1.4 it needs the local WebLogic client, as JNDI is read over T3 there.

The lifecycle profile is mutating and should only be used against a prepared demo lab. It may start, stop, suspend, resume, or restart demo resources, and the harness audits `/api/wls` traffic so checks cannot perform undeclared WebLogic operations.

The topology configuration checks are opt-in. Read-only coverage can inspect the server and cluster configuration affordances without changing WebLogic:

```bash
WLS_SMOKE_PASSWORD=<password> \
WLS_SMOKE_CHECKS=topology-server-config-readonly,topology-clusters-config-readonly \
npm run smoke:visual:readonly
```

`WLS_SMOKE_PROFILE=topology-config` is reserved for disposable configuration checks. Use only against a prepared lab, with placeholder-safe names that do not already exist in the domain. The preflight check verifies that the names are free:

```bash
WLS_SMOKE_APP_URL=http://localhost:5173 \
WLS_SMOKE_TARGET=http://wls-admin.example.com:7001 \
WLS_SMOKE_VERSION=14.1.2.0.0 \
WLS_SMOKE_PROFILE=topology-config \
WLS_SMOKE_CHECKS=topology-config-disposable-preflight \
WLS_SMOKE_TOPOLOGY_SERVER_NAME=WLSCockpitSmokeServer \
WLS_SMOKE_TOPOLOGY_CLUSTER_NAME=WLSCockpitSmokeCluster \
WLS_SMOKE_USERNAME=<username> \
WLS_SMOKE_PASSWORD=<password> \
npm run smoke:visual
```

The mutating check creates a disposable cluster and managed server, captures the UI, then deletes the server before deleting the cluster:

```bash
WLS_SMOKE_APP_URL=http://localhost:5173 \
WLS_SMOKE_TARGET=http://wls-admin.example.com:7001 \
WLS_SMOKE_VERSION=14.1.2.0.0 \
WLS_SMOKE_PROFILE=topology-config \
WLS_SMOKE_CHECKS=topology-config-disposable-mutations \
WLS_SMOKE_TOPOLOGY_SERVER_NAME=WLSCockpitSmokeServer \
WLS_SMOKE_TOPOLOGY_CLUSTER_NAME=WLSCockpitSmokeCluster \
WLS_SMOKE_USERNAME=<username> \
WLS_SMOKE_PASSWORD=<password> \
npm run smoke:visual
```

The disposable checks query the edit tree first and fail if either configured name already exists. The mutating check uses explicit disposable names, cleans up created resources, attempts cleanup on failure, and keeps REST audit allow-lists narrow enough that undeclared topology operations fail the smoke run.

## License

Apache License 2.0. Not affiliated with, endorsed by, or supported by Oracle. Oracle and WebLogic are trademarks of Oracle Corporation.
