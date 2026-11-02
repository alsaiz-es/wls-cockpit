# UI Guidelines

This document is the visual and interaction direction for WLS Cockpit. It is
authoritative for anyone implementing UI: every screen, component, and
state must be consistent with what is described here. When something is
ambiguous, **stop and ask** — do not guess or default to generic shadcn
patterns.

## 1. What we are building

WLS Cockpit is an **operational admin tool** for WebLogic. The user is a
sysadmin or middleware engineer who lives in this app for hours, runs it on
a second monitor next to a terminal, and uses it to keep production-like
domains alive. They need to see a lot of state at once, act on it quickly,
and trust what they see.

### Reference products (look at these when in doubt)

- **Linear** — density, keyboard, restraint with color, monospace where it
  helps.
- **Vercel and Railway dashboards** — operational data, status pills, log
  panels, dark-default chrome.
- **Cloudflare dashboard** — dense tables with status indicators, no fluff.
- **Grafana / Datadog** — multi-panel layouts, time-series alongside lists.
- **htop / k9s** — extreme information density; we live closer to this end
  than to "marketing SaaS".

### Reference products to deliberately **not** look like

- Stripe Dashboard or Notion-style consumer SaaS — too much breathing room,
  too many cards, too much chrome.
- Material Design admin templates — round corners on everything, drop
  shadows, decorative icons on every row.
- MBean-tree navigation with auto-generated forms, the model of a general
  configuration console. Cockpit is task-oriented and complements the
  WebLogic Remote Console rather than mirroring it.

### Tone in one paragraph

Cool, dense, dark by default. Information first, decoration zero. Status
colors are loud only where they encode operational meaning; everything else
is a quiet neutral palette. Monospace where the value is technical
(server names, paths, ports, hashes). One accent color, used sparingly. No
hero sections, no illustrations, no animated skeletons, no rounded-2xl
panels.

## 2. Layout shell

Every authenticated route renders inside this shell. The login screen is
the only exception: the brand row (mark, name, version) and the connection
cards, centered on a plain background.

```
┌──────────────────────────────────────────────────────────────────────┐
│ TopBar  (40px, sticky)                                               │
│  • Breadcrumb                                                        │
│  • Active domain name + environment indicator (right)                │
│  • User chip + Switch domain + Sign out                              │
├──────────────────────────────────────────────────────────────────────┤
│ Side  │                                                              │
│ Nav   │                                                              │
│       │                  Main content                                │
│ 200px │                  (fluid width, no max-width container)       │
│       │                                                              │
│       │                                                              │
│       │                                                              │
│       │                                                              │
└──────────────────────────────────────────────────────────────────────┘
```

### TopBar

- Height: 40 px.
- Background: same as page surface; bottom 1 px border in the divider color.
- Left: breadcrumb (e.g. `Domain / Servers / server1`). Each segment is a
  link except the last. Separator is `/` in muted color.
- Right cluster:
  - **Active domain name** — the connection profile's display name, 13 px
    medium, truncated with the full name in the tooltip. It sits right before
    the environment indicator: two profiles can share a host and port, so the
    name is what tells the operator which domain they are acting on.
  - **Environment indicator** — colored dot + short label. Format:
    `<host>:<port> · v<wls-version>`. The dot is green when the last poll
    succeeded, amber while loading, red on error. The host string is in
    monospace.
  - **Theme mode control** — compact icon-only group for Dark, Light, and
    System. Each choice is a square button with an accessible label and
    selected state; no explanatory text or settings page.
  - **Jump**, the **alerts bell** and **Snapshot** (diagnostic export) sit
    between the domain name and the theme control.
  - **User chip** — `weblogic` (username) in monospace, no avatar.
  - **Switch domain** and **Sign out** — ghost variant, 28 px tall, each with
    an icon and a tooltip that says what happens to the session. Switch keeps
    the current connection until another domain is connected (the connections
    page shows it with a way back); Sign out forgets the password in the tab.

### SideNav

- Width: 200 px, fixed. Collapses to a 48 px icon-only rail (later — not in
  v1, but reserve the prop on the component).
- Top: a 48 px brand row with the app mark (`/favicon.svg`, 20 px),
  `WLS Cockpit` in 13 px semibold and the version (`v` + `package.json`
  version, injected as `__WLS_COCKPIT_VERSION__`) in 11 px mono, subtle
  color. No illustration, no tagline.
- Items, in groups with an 11 px uppercase subtle heading: Dashboard (no
  heading); Runtime (Servers, Clusters, Work Managers, Node Manager);
  Resources (Deployments, Data Sources, JMS, Stores & SAF, JNDI, JTA);
  Operations (Security, Logs, Config Snapshots, Action Audit). Headings do
  not collapse.
- Each item: 14 px icon (lucide) + label, 32 px tall row, 12 px horizontal
  padding.
- Active route: subtle accent background (8 % accent over surface) with a
  2 px left border in the accent color. Inactive: no background, hover sets
  a 4 % surface lift.

### Main content

- Padding: 24 px horizontal, 20 px top, 24 px bottom.
- **No `max-w-*` container.** Tables expand to fill the viewport. The user
  has the screen real estate; do not waste it.
- The first child is always a page header (Section 4) followed by content.

## 3. Density & spacing

Tighter than default shadcn. Use these tokens consistently.

| Token              | Value | Used for                                            |
|--------------------|-------|-----------------------------------------------------|
| Space 0            | 0 px  |                                                     |
| Space 1            | 4 px  | Hairline gaps inside a row, icon to label           |
| Space 2            | 8 px  | Inline groups (button cluster, badge + text)        |
| Space 3            | 12 px | Form field stacking, table cell padding-y           |
| Space 4            | 16 px | Section gaps                                        |
| Space 5            | 24 px | Page padding, distinct section blocks               |
| Space 6            | 32 px | Top/bottom of empty states only                     |

- Default row height in tables: **36 px** (comfortable). Compact mode (later
  toggle) is **28 px**. Header row matches body height.
- Form field height: **32 px**. Buttons match.
- Buttons: horizontal padding 12 px (default), 8 px (sm), 16 px (lg).

## 4. Page header

Every authenticated page starts with the same header pattern. **Do not put
a page header inside a `Card`.** Just plain divs.

```
┌─────────────────────────────────────────────────────────────────┐
│ Page Title                                  [Primary action]    │
│ One short sentence describing the view.                         │
│                                                                 │
│ ┌──────────────────────────────────────────────────────────┐    │
│ │ Filters / search row (when applicable)                   │    │
│ └──────────────────────────────────────────────────────────┘    │
│                                                                 │
│  ── content (table, panels, etc.) ──                            │
└─────────────────────────────────────────────────────────────────┘
```

- Page title: 18 px, weight 600.
- Subtitle: 13 px, muted color, single line. Optional.
- Primary action: top-right, single button in the primary variant. Secondary
  actions sit to its left as ghost buttons; if there are many, move them into
  a `…` menu.
- Second row (`PageHeader` `meta`, `updatedAt`, `refreshing`, `onRefresh`):
  page-level toggles and counts on the left; on the right, always in this
  order, `Updated <relative time>`, the refetch spinner, and one ghost
  `Refresh`. One page-level Refresh; only a section with its own live
  stream (a log tail) keeps its own controls. Detail pages put the `← <list>` link
  first on the left: it returns to the list with the filters and sort the
  operator left there, which the breadcrumb does not.
- 16 px gap between header block and the next element.

## 5. Typography

### Font stacks

```css
--font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
             "Helvetica Neue", Arial, sans-serif;
--font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas,
             "Liberation Mono", monospace;
```

System stack only — do **not** load web fonts in v1. We are a local-network
admin tool; cold-start latency matters.

### Sizes

| Token   | px | line-height | Used for                                    |
|---------|----|-------------|---------------------------------------------|
| text-xs | 11 | 14          | Footnote, badge text                        |
| text-sm | 13 | 18          | Body, table cells, inputs, buttons          |
| text-md | 14 | 20          | Section labels, table headers               |
| text-lg | 16 | 22          | Drawer titles, modal titles                 |
| text-xl | 18 | 24          | Page titles                                 |
| text-2xl| 22 | 28          | Big numbers in stat cards (sparingly)       |

**Body default is 13 px.** Anything bigger is a hierarchy choice, not a
default. shadcn defaults to 14 px; override.

### Monospace usage

Use `font-mono` for **technical strings**. Never for prose. Examples:

- Server names: `osb_server1`
- Hostnames and ports: `wls-admin.example.com:7001`
- Version strings: `14.1.2.0.0`
- Paths: `/domains/example_domain`
- IDs, UUIDs, hashes
- Numbers in operational tables (so columns line up — see §10)

Sans for: page titles, section labels, body copy, button labels, error
messages, empty-state text.

### Tabular numbers

Any column or stat that displays numbers must use tabular figures so they
line up. Apply `font-feature-settings: "tnum"` (Tailwind: `tabular-nums`)
globally on `<table>`, on stat-card numbers, and on log row prefixes.

## 6. Color system

Dark mode is the **default and primary** experience. Light mode is
supported but always tested second. The app shell exposes a global theme
mode control with Dark, Light, and System choices. Missing, invalid, or
unreadable local preferences fall back to Dark; System follows
`prefers-color-scheme` while the app is open. The only persisted value is
the selected mode string (`dark`, `light`, or `system`) in browser-local
storage; never store credentials, target hosts, usernames, domain names,
or connection metadata with the theme preference.

### Neutrals (dark mode)

- `--background`: oklch(0.13 0 0) — near-black page background.
- `--surface-1`: oklch(0.16 0 0) — sidebar, top bar, hovered rows.
- `--surface-2`: oklch(0.19 0 0) — drawers, modals, popovers.
- `--border`: oklch(1 0 0 / 8%) — table dividers, panel edges.
- `--border-strong`: oklch(1 0 0 / 14%) — input borders, focus rings.
- `--foreground`: oklch(0.98 0 0) — primary text.
- `--muted-foreground`: oklch(0.65 0 0) — labels, helper text, secondary
  metadata.
- `--subtle-foreground`: oklch(0.5 0 0) — placeholder, disabled text,
  separators.

The current `app/src/index.css` is the shadcn baseline. When implementing,
override these tokens to match the values above (or close approximations).

### Accent

One accent color, used sparingly:

- `--accent`: a clear blue, around `oklch(0.7 0.15 240)`.
- Use for: primary buttons, active nav row, focus rings, the dot in
  positive notifications. **Not** for text body, not for table headers,
  not for icons that already carry semantic meaning (status icons).

### Status palette (operational meaning)

Every status color encodes a real operational state. Do not use these
colors for decoration. Numbers and labels that report a healthy value stay
in the foreground color; green is for the dot of a status badge, not for a
KPI that happens to be fine. A degraded or critical summary panel gets a
3 px left strip in the status color, not a tinted background. Pair colors with text (and ideally an icon) — never
rely on color alone.

| Status meaning             | Color                       | Tailwind-ish          |
|---------------------------|-----------------------------|-----------------------|
| Healthy / RUNNING / OK     | green `oklch(0.72 0.16 145)` | `emerald-500`         |
| Warning / starting / degraded | amber `oklch(0.78 0.15 80)` | `amber-500`           |
| Failure / FAILED / 5xx     | red `oklch(0.65 0.22 25)`   | `red-500`             |
| Stopped / SHUTDOWN / inactive | neutral `oklch(0.5 0 0)` | `zinc-500`            |
| Unknown                    | muted neutral, italic label | `zinc-400`            |

### Light-mode QA

Light mode must preserve the same operational hierarchy as dark mode. When
touching shared UI, verify the shell, side nav, tables, filters, forms,
dialogs, popovers, badges, focus rings, charts, empty states, and error
states in both themes. Text and icons must remain legible against their
surfaces; hover, selected, disabled, and focus states must be visible; and
status colors must keep their existing meaning without relying on color
alone. Dark mode remains the visual baseline, so light-mode fixes should
adjust only readability and contrast gaps rather than changing spacing,
layout, or semantics.

### WebLogic state mapping

The WLS REST API returns lifecycle states like `RUNNING`, `STARTING`,
`STANDBY`, `ADMIN`, `SUSPENDING`, `SUSPENDED`, `RESUMING`, `SHUTTING_DOWN`,
`SHUTDOWN`, `FORCE_SUSPENDING`, `FAILED_NOT_RESTARTABLE`, `UNKNOWN`. Map
them to the palette as follows:

| WLS state                    | Color  |
|------------------------------|--------|
| `RUNNING`                    | green  |
| `STARTING`, `RESUMING`       | amber  |
| `ADMIN`, `STANDBY`           | amber (warning shade) |
| `SUSPENDING`, `SUSPENDED`, `FORCE_SUSPENDING` | amber |
| `SHUTTING_DOWN`              | amber  |
| `SHUTDOWN`                   | neutral |
| `FAILED_NOT_RESTARTABLE`     | red    |
| `UNKNOWN` / anything else    | muted neutral |

`healthState.state` is independent: `ok` = green, `warn` = amber, `critical`
or `failed` = red, `overloaded` = amber. When both lifecycle and health
exist, the **worse** of the two wins for any aggregated indicator
(e.g., the dot in the TopBar).

## 7. Component conventions

### 7.1 Tables (the most important component)

Tables are the backbone of this app. Treat them as a first-class component,
not as something wrapped in a `Card`.

Visual rules:

- No card wrapper. Just `<table>` directly inside the page content. A 1 px
  bottom border under the header and 1 px dividers between rows in
  `--border` color.
- No zebra striping. Hover state: row background lifts to `--surface-1`.
- Row height 36 px. Header row matches.
- Header cells: 13 px, weight 500, muted-foreground, **uppercase letter
  spacing**: `letter-spacing: 0.04em`, `font-feature-settings: "tnum"`.
- Body cells: 13 px. First column is an identifier and is monospace.
  Numerical columns are right-aligned and monospace + tabular-nums.
  Status columns use a status badge (§7.2).
- Row truncation: text columns truncate with `text-overflow: ellipsis`.
  The full value is available in a `title` tooltip.
- Sticky header when the table is taller than the viewport.
- Multi-select: 32 px first column with checkbox. Selected rows have a 2 px
  left border in accent color and a faint accent-tinted background
  (`accent / 10%`). A floating action bar appears at the bottom-right of
  the page when one or more rows are selected (§7.7).
- Sortable columns: header becomes interactive on hover, with a small
  caret icon. Default sort is documented per page.
- Empty state: a 48 px tall row with centered muted text + (optional)
  primary action (§9.2).
- Row actions: one primary action as a button (Test, Start/Stop) and the
  rest in a `…` menu (`<RowActions>`), in a narrow column pinned to the
  right edge (`sticky: 'right'` on the column) so it stays visible when a
  wide table scrolls horizontally. The row's primary action uses the
  secondary variant even when it is destructive (Stop, Shutdown): in a domain
  with dozens of applications a red button per row is noise. The confirmation
  dialog carries the destructive styling. Destructive items go last, after a
  separator. Every lifecycle or configuration action, not only destructive
  ones, goes through `<ConfirmDialog>`, whose text names exactly what is
  affected (e.g. every target of a redeploy).

Concrete example — Servers table:

```
┌──────┬────────────────────┬─────────┬────────┬──────────┬──────────┬─────────┐
│ ☐    │ NAME               │ STATE   │ HEALTH │ HEAP     │ THREADS  │ LISTEN  │
├──────┼────────────────────┼─────────┼────────┼──────────┼──────────┼─────────┤
│ ☐    │ AdminServer        │ ● RUN   │ ● ok   │ ███▒░ 67%│   42     │ :7001   │
│ ☐    │ osb_server1        │ ● RUN   │ ● ok   │ █████ 91%│  138     │ :7003   │
│ ☐    │ osb_server2        │ ○ DOWN  │ –      │ –        │ –        │ :7004   │
└──────┴────────────────────┴─────────┴────────┴──────────┴──────────┴─────────┘
```

- `NAME`: monospace, 200 px min, click → drawer.
- `STATE`: status badge with dot.
- `HEALTH`: status badge.
- `HEAP`: 80 px progress bar + `XX%` text, both color-coded by threshold
  (green < 70 %, amber 70 – 89 %, red ≥ 90 %).
- `THREADS`: right-aligned monospace number.
- `LISTEN`: monospace `:port` (or full `host:port` when not the default
  host).

### 7.2 Status badge

```
● RUNNING        — green dot + uppercase label, monospace, 11 px text
○ SHUTDOWN       — neutral dot + label
⚠ STARTING       — amber dot + label
✕ FAILED         — red dot + label
```

- 8 px dot + 4 px gap + label.
- Label is uppercase, 11 px, monospace, `letter-spacing: 0.05em`.
- No pill background. The dot carries the color. Warning and failure labels
  take the status color; healthy and neutral labels stay muted, so in a long
  table the rows that need attention are the only colored text.
- One status column per table. Secondary health signals (WebLogic health,
  overall health) go in the badge tooltip and on the detail page, not in
  extra badge columns. Categories (scope, type) are plain text, not badges.
- Use the same component everywhere (table cells, drawer headers, top-bar
  environment indicator).

### 7.3 Buttons

| Variant     | Background           | Border        | Text                | Use                          |
|-------------|----------------------|---------------|---------------------|------------------------------|
| primary     | accent               | none          | accent-foreground   | The single primary action    |
| secondary   | surface-1            | border-strong | foreground          | Common actions               |
| ghost       | none                 | none          | foreground          | Inline actions, toolbar      |
| destructive | red-500              | none          | white               | Stop / undeploy / delete     |
| outline-destructive | none         | red-500       | red-500             | Pre-confirmation destructive outside tables |

Sizes: `sm` (28 px), default (32 px), `lg` (36 px). No icon-only round
buttons. Icon-+text is fine; icon-only uses square 28 px with a tooltip.

### 7.4 Inputs and selects

- Height 32 px. Border 1 px in `border-strong`. Focus: 2 px ring in accent.
- Placeholders in `subtle-foreground`.
- Labels above the input, 13 px, weight 500. Helper text below, 11 px,
  muted.
- Error state: red border + 11 px red helper text.
- Selects use the native `<select>` for v1 (already used in `Login.tsx`).
  Replace with a Radix Select only when we need search/grouping/multi.
- Filter selects share `FILTER_SELECT_CLASS`, use the sans font and sentence
  case (`All servers`, `Warning`; `filterOptionLabel`), and keep server and
  resource names exactly as WebLogic reports them.

#### Dense configuration editors

Topology configuration editors are not generic CRUD forms. They expose
WebLogic edit-tree fields in console-aligned sections and must stay
scannable next to the runtime data.

- Render each section as a compact bordered panel with a small header, muted
  description, and a dense field table. Do not wrap each field or subsection
  in a card.
- Read mode comes first. Show current values in a two-column table
  (`FIELD`, `VALUE`) and keep identifiers, ports, paths, and references in
  monospace.
- Edit controls are per section. The primary page action may create the
  top-level resource, but existing-resource edits should be scoped to the
  section being changed.
- Forms send only changed allow-listed fields. Read-only and unsupported
  fields stay visible with a reason, but are not editable.
- Sensitive or write-only fields never display stored values. Use a muted
  `redacted`/`write-only` label and never echo submitted secret values in
  confirmations, errors, audit summaries, screenshots, or tracked artifacts.
- Fields that require restart or activation impact show a short muted note
  beside the field, not a large warning block unless the operation is
  destructive.
- Create, edit, child-resource mutation, and delete actions use an
  edit-session confirmation. The confirmation describes the resource,
  section, and operation, not raw payloads.
- Destructive topology actions use `<ConfirmDialog>` with the destructive
  button variant and must state the guard that was checked (for example
  AdminServer protection, stopped/runtime-unavailable eligibility, or
  cluster member/reference preflight).
- Read-only and demo modes hide topology mutation controls entirely. They
  should not leave disabled buttons that imply the operation could be
  unlocked from the current view.

### 7.5 Detail pages and drawers

Drill-down opens a **detail page** (`/servers/:name`, `/deployments/:server/:name`,
…): the page header of §4 with the `← <list>` link that restores the list's
filters and sort, tabs when the object has several views (Overview, Metrics,
Configuration, Debug), a `<KeyValueGrid>` (§7.9) for its facts, and tables for
its children. Pages, unlike drawers, can be linked, reloaded and opened side by
side, which an operator comparing two servers needs.

A **right-side drawer** is reserved for short secondary content that must keep
the list visible behind it. None exists today; if one is added, it follows
the rules below. Drawer width: 480 px (resizable later).

- Slide-in animation: 200 ms ease-out. No backdrop blur (it tanks perf and
  hides the data behind, which is the point of a drawer over a modal).
- Backdrop: black at 40 % opacity, click to dismiss.
- Esc closes. Focus trap inside.
- Drawer header: 48 px, status badge + title + close button. 1 px bottom
  border.
- Drawer body: scrollable, padded 16 px.
- Drawer footer (optional): 56 px, sticky bottom, separator, primary action
  on the right.

### 7.6 Modals

Reserved for **destructive confirmations and short forms**. Anything that
shows operational data goes in a drawer, not a modal. Width 400 px, height
auto.

### 7.7 Selection action bar

Appears at the bottom-center of the viewport when one or more rows are
selected.

```
┌────────────────────────────────────────────────────────────┐
│ 3 servers selected   [Restart]  [Stop]  [Cancel selection] │
└────────────────────────────────────────────────────────────┘
```

- Floating, 48 px tall, `surface-2` background, 1 px border, 8 px radius,
  16 px shadow.
- 24 px above the bottom edge.
- Counts in monospace. Actions are buttons (destructive variant for Stop).

### 7.8 Cards (used sparingly)

Use a card **only** to group truly unrelated content on a dashboard or to
isolate a small KPI. Never wrap a single table in a card. Never wrap a
form in a card unless it stands alone on the page (the login form is the
exception).

Card: 1 px border in `border`, 8 px radius, no shadow, 16 px padding,
`surface-1` background.

### 7.9 Key–value grids

Facts about one object on a detail page (identity, configuration, runtime
metadata, counters nobody charts) go in a `<KeyValueGrid>`: rows of 32 px
with an 11 px uppercase muted label on the left and the value on the right,
in two to four columns. Monospace only for identifiers, paths, versions and
numbers; states and vendor names stay sans. Keep stat tiles (§7.8) for the
three or four numbers an operator watches, not for every field.

## 8. Iconography

- Library: `lucide-react`.
- Default icon size: 14 px next to 13 px text, 16 px next to 14+ px text.
  Exact: match icon px to (text-px - 2) for inline metadata.
- Stroke width: 1.5 (thinner than default 2). Set globally on the icon
  component or per-instance.
- **Icons are not decoration.** Allowed uses: status, action verbs (start,
  stop, restart, refresh), navigation entries (one icon per nav item is
  OK — it is a sidebar), affordance hints (caret for sort, chevron for
  expand). Disallowed: an icon next to every list label "to make it look
  nice".

## 9. State semantics

Every data-driven view has four states. Implement all four explicitly,
even when the empty or error state is rare. **No surprise blank screens.**

### 9.1 Loading

- **First load**: spinner top-right of the section + "Loading…" muted
  label, no skeleton. The spinner stays in place until first response.
  Layout reserves the space the table will eventually occupy (so nothing
  shifts).
- **Refetch over existing data**: do not blank the table. Dim the data
  slightly (`opacity: 0.7`) for as long as the request takes and show the
  spinner next to `Updated` in the page header, never over the table, where
  it would cover row actions. Replace data when it arrives.

### 9.2 Empty

- Centered block inside the table area, 96 px tall.
- Single line of muted text describing why it is empty
  (e.g. *"No servers reported by this domain."*).
- Optional secondary line with a hint
  (*"Configure managed servers in the WebLogic admin console."*).
- Optional primary action button.
- No illustrations. No big icons. Maybe one 24 px icon if it disambiguates.
- Idle is not empty and not unavailable. A view that waits for the operator
  (metric capture before Start) shows one idle block that says what starts
  it, not a grid of empty charts. "Unavailable" is only for data WebLogic
  does not provide.

### 9.3 Error

- Banner above the data area, full width, 1 px red border, red-tinted
  background (`red-500 / 8%`), 12 px padding.
- Single line: error message in monospace if it includes technical detail
  (HTTP status, stack hint), sans otherwise.
- Right-side: ghost button "Retry" that re-runs the query.
- Below the banner, keep the **last successful data** visible if any.
  Operators value stale-but-known data over a blank screen.

### 9.4 Partial failure

When part of the data fetched OK and part did not (e.g., one of N parallel
requests failed):

- Show the rows that succeeded.
- Annotate the affected rows with a small red exclamation icon and a
  tooltip describing the failure.
- Add an info banner above the table summarizing what is missing.

## 10. Data display

### Numbers

- Right-align in tables.
- Monospace + tabular-nums.
- Locale-aware grouping (`toLocaleString`) for counts ≥ 1000.
- Bytes: format with `Intl.NumberFormat` and a unit suffix (`KB`, `MB`,
  `GB`). Use binary units (1024-based) since WebLogic reports them that
  way; label them as `KB` / `MB` / `GB` (acceptable colloquial use).
- Percentages: integer percent up to 99, one decimal at 99.x and beyond.
  Append the `%` glyph with no space.
- Durations: `2.4s`, `483ms`, `1m 12s`, `2h 03m`. No fractional minutes.

### Timestamps

- Default display: relative (`3m ago`, `12h ago`, `Apr 28`).
- Hover tooltip: full ISO-8601 in local time + UTC offset.
- Inside log views: absolute local time `HH:MM:SS.mmm`, full date in the
  tooltip, and a muted separator row wherever the day changes. Each record
  stays on one line: the message truncates and a click expands it in place.

### Identifiers

- Always monospace.
- Truncate from the middle with ellipsis if necessary
  (`abcde…d29f` style), full value in tooltip.

### Heap / CPU bars

- 80 px wide, 6 px tall, 3 px radius.
- Filled portion uses status threshold colors: green < 70 %, amber 70–89 %,
  red ≥ 90 %.
- Numeric label (e.g. `67%`) sits 4 px to the right of the bar in the same
  status color. Right-aligned in the cell so columns line up.

## 11. Motion

Strict diet.

- Drawer open / close: 200 ms ease-out.
- Modal open / close: 150 ms ease-out, no scale animation, fade only.
- Page route change: instant. No fade, no slide.
- Hover states: instant (no transition).
- Focus rings: instant.
- Spinner: standard CSS rotation, 1 s, linear.
- **No skeleton loaders that animate.** They are slower than the data.
- **No entrance animations on lists or cards.** The view is just there.

## 12. Keyboard and accessibility

v1 minimums:

- All interactive elements reachable by Tab in DOM order.
- Visible 2 px focus ring in accent color on every focusable element.
- `Esc` closes drawers and modals.
- `Enter` submits forms (login).
- Buttons are real `<button>` elements; links are real `<a>` elements.
- Tables: header cells are `<th scope="col">`. Sortable headers expose
  `aria-sort`.

v2 (later changes):

- `⌘K` command palette.
- `j` / `k` row navigation in tables.
- `g s` to jump to Servers, `g d` to Dashboard, etc. (Linear-style
  two-letter shortcuts.)

## 13. Anti-patterns (do not ship these)

The most useful section. **Do not** do any of the following without an
explicit override from Claude:

- Wrapping a single table in a `<Card>`. The page already provides the
  surface.
- Wrapping the whole page content in `max-w-3xl mx-auto`. We are not a
  blog post.
- Using `text-muted-foreground` for body copy. Muted is for labels and
  metadata, not paragraphs.
- Putting a status pill background under every status label. The dot is
  enough.
- Adding an icon next to every nav label and table column header.
- Using accent color on more than one element per visible region (one
  primary CTA, one active nav row, etc.).
- Skeleton loaders on tables. Use the dimmed-data pattern (§9.1).
- Round corners larger than 8 px on buttons, inputs, or tables.
- Drop shadows on cards.
- Spring or bounce animation curves.
- Pastel accent color (lavender, mint, rose). Our accent is a clear blue.
- Centering forms in a giant card on operational pages. Tables go full
  width; forms inline with their context (drawer or page section).
- Decorative SVG illustrations in empty states.
- Fonts loaded from a CDN. System stack only.
- New typography sizes outside the table in §5. If a new size is needed,
  propose adding it here first.

## 14. Component primitives we will build

To enforce these conventions, we will introduce and reuse the following
primitives. Use them rather than re-implementing per-page. They
do not all exist yet — they appear when their first feature needs them.

- `<AppShell>` — sidebar + topbar + main slot.
- `<PageHeader title subtitle action>` — page title block (§4).
- `<DataTable columns rows selection sort empty error loading>` — the
  one-and-only table component (§7.1).
- `<StatusBadge state>` — dot + label (§7.2). Accepts WLS lifecycle and
  health states directly.
- `<RestartRequiredBadge>` — warning badge next to a server's lifecycle state
  when its runtime reports `restartRequired` after an activation.
- `<Drawer open onOpenChange title>` — right-side drawer (§7.5).
- `<ConfirmDialog>` — destructive-action modal (§7.6).
- `<RowActions primary more>` — primary row action plus a `…` dropdown
  menu (shadcn `dropdown-menu`) (§7.1).
- `<SelectionBar count actions>` — floating action bar (§7.7).
- `<HeapBar value max>` — labeled progress bar (§10).
- `<RelativeTime value>` — `12m ago` with absolute tooltip (§10).
- `<KeyValueGrid items columns>` — label–value rows for detail pages (§7.9).
- `<MonoText>` — `font-mono` text wrapper for identifiers and paths.

When in doubt, **add a primitive** rather than inline one-off classes
across pages. The catalogue grows feature-by-feature.

## 15. How to use this document

- When implementing: read the relevant sections before touching UI. When a
  change creates a new visible element, cross-check it against the section
  that covers it, and cite the section in the PR or commit if it matters
  (e.g., *"per docs/ui/guidelines.md §7.1 the table does not use a card
  wrapper"*). Add a new section when a feature introduces a pattern not yet
  covered, and commit that update with the feature.
- When reviewing: if something feels off, the answer is usually in here. If
  it is not, propose an addition.

This document is living. Tighten it as we ship.
