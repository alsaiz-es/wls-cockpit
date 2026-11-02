# Vendored WLS REST OpenAPI specs

`wls-14.1.2.yaml` and `wls-12.2.1.4.yaml` are vendored copies of the
generated specs from the sibling project `weblogic-rest-openapi`
(`specs/generated/<version>.yaml`). They are the input to `npm run gen`,
which produces the typed client under `app/src/api/generated/`.

Do not hand-edit them for spec content: fix the sibling repo's samples or
overlays and re-vendor, otherwise the change is lost on the next copy.

## Re-vendoring

```bash
cp <sibling>/specs/generated/14.1.2.0.0.yaml  openapi/wls-14.1.2.yaml
cp <sibling>/specs/generated/12.2.1.4.0.yaml  openapi/wls-12.2.1.4.yaml
```

Then apply the sanitization steps below and regenerate:

```bash
cd app && npm run gen && npm run lint && npx tsc -b --force && npm run test:unit
```

### 1. Drop `info.contact.url`

The upstream specs carry a `contact.url` pointing at the sibling project's
GitHub account. That attribution is correct in the repo that publishes it,
but this repo does not vendor personal handles — delete that single `url`
line (around line 39) from each file. Keep `contact.name`: it names the
project, not an account.

```yaml
  contact:
    name: weblogic-rest-openapi (unofficial)
    url: https://github.com/<handle>/weblogic-rest-openapi   # <- delete this line
```

### 2. Neutralize installation paths, domain names and schema users

Runtime samples are harvested from lab domains and carry their install
layout: Oracle home and JDK directories (`middlewareHome`, `weblogicHome`,
`serverClasspath`), the domain directory and name (`currentDirectory`, the
`DomainRuntime` `name`), and the RCU schema prefix in JDBC `user` fields.
Replace them in the vendored copies with neutral values:

| Value | Replacement |
|---|---|
| Oracle / middleware home | `/u01/oracle/middleware` |
| JDK home | `/u01/oracle/jdk` |
| Domain directory | `/u01/oracle/domains/example_domain` |
| Domain name | `example_domain` |
| RCU schema prefix | `EXAMPLE_` (for example `EXAMPLE_SOAINFRA`) |

The replacement only touches `examples`, so `npm run gen` must produce
byte-identical types before and after. The second command of the scrub gate
below finds anything left over.

### 3. Run the scrub gate — must come back empty

Harvested samples occasionally carry lab-specific values (private IPv4
addresses, IPv6 ULAs with zone-ids, personal home paths, install paths,
real deployed application names, hostnames). Upstream sanitizes at the
sample level, but verify after every re-vendor. The first command looks for
network and home-directory leaks, the second for install layout leftovers;
application names and hostnames still need a read of the `examples` diff:

```bash
rg -n --pcre2 '\b(192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b|[/@\[ ]10\.\d{1,3}\.\d{1,3}\.\d{1,3}:|\bf[cd][0-9a-f]{2}:[0-9a-f:]+|%(en|eth|wl)[a-z0-9]*\b|(?<!\w)/(Users|home)/' openapi/ --glob '!README.md'
rg -n -U --pcre2 '(middlewareHome|weblogicHome|currentDirectory): (?!/u01/oracle/)|user: (?!EXAMPLE_)[A-Z0-9]+_(SOAINFRA|MDS|OPSS|UMS|IAU|WLS|STB)|(?<![\w/.])/(?!u01/)[\w-]+/[\w./-]*/lib/[\w.-]+\.jar|^\s+name: (?!example_domain\n)\S+\n\s+activationTime:' openapi/ --glob '!README.md'
```

(The `--glob` skips this file, which contains the patterns it searches
for.) Any hit is a blocker. Fix it upstream in `weblogic-rest-openapi` (samples,
not generated output) so the next re-vendor stays clean, then re-copy.
