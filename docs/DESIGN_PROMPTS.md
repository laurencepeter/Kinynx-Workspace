# Design prompts (Claude artifacts)

Copy-paste prompts for designing Kinynx screens as linked, clickable artifacts.
Start with **0 — Design system**, then reuse its link or tokens in every later
prompt so all screens share one look. Each prompt names the real API data
shapes, so the designs map 1:1 onto what the backend already returns.

> Tip: run them in order in one conversation and say "link it to the previous
> screens" each time. Ask for "realistic sample data, ~25 records" so charts
> look lived-in.

---

## 0 — Design system

```
Create a design system artifact for "Kinynx", an open-source, free, self-hostable
collaborative workspace (docs + databases + kanban + dashboards), positioned like
AppFlowy/Notion but calmer and faster.

Tokens (dark first, light second, both fully specified):
- Surfaces: bg #0e0f13, panel #171922, panel-2 #1e2130, border #2a2e3f
- Text #e7e9f0, muted #9aa0b4; accent #6d5efc (user-customizable), accent-2 #22d3ee
- Chart categorical order (fixed, never cycled): #3987e5 #d95926 #199e70 #c98500
  #d55181 #008300 #9085e9 #e66767. Status: good #199e70, warning #c98500, bad #e66767,
  always paired with an icon + label.
- Radius 12 (cards) / 9 (controls); 4px spacing grid; system sans; tabular numbers.
- Density modes: comfortable and compact.

Show: color swatches with contrast ratios, type scale, buttons (primary/ghost/icon/
danger), inputs, selects, tabs, pills, stat tiles (label, value, delta, sparkline),
a meter with WIP-limit overflow state, a chart card frame, a dialog, a toast,
empty states, and keyboard focus rings. Include a theme toggle and a density toggle.
```

## 1 — App shell & navigation

```
Using the Kinynx design system, design the app shell: top bar (logo, Docs / Board /
Insights / Admin nav, workspace switcher "Acme / Product", presence avatars,
notifications bell, ⌘K search), a collapsible left sidebar with a nested page tree,
databases list and dashboards list (★ marks the default dashboard).
Make every nav item clickable and switch the main area between placeholder screens
named Docs, Board, Insights, Data. Responsive: sidebar becomes a drawer under 820px.
```

## 2 — Data grid (the source of truth)

```
Design the Kinynx data grid for a "Projects" database with properties:
Title (text), Status (select: Backlog, Todo, In progress, Review, Done — each colored),
Points (number), Due (date), Owner (select: Alex, Sam, Riley), Tags (multi-select),
Cost (formula "[Points] * 120"). 25 realistic rows.
Include: inline cell editing per type, a header menu (rename, change options,
hide, delete), "+ Property" dialog with type picker, filter + sort bar, row
selection with bulk actions, an activity side panel ("Sam moved Status:
Review → Done · 2h ago"), and a "⇩ CSV" export button.
When a cell changes, update a live summary row (count, sum of Points, % Done).
Use in-memory state so edits persist while I click around.
```

## 3 — Workflow builder

```
Design the Kinynx workflow builder for the Projects database. Left: ordered stage
list (drag to reorder) with name, color, category (To do / In progress / Done) and
a WIP limit. Right: an "allowed moves" matrix (from × to checkboxes, plus "Any"),
and an "Enforce on server" switch. Above: a live flow diagram of the stages as
nodes with arrows for allowed moves; WIP-limited stages show "3 max".
Add a "Try a move" sandbox: pick a card and a target stage and show the API's
answer — 200 OK, 422 "moving from Todo to Done is not allowed", or 409 "In progress
is at its WIP limit (3)". Link "Save" to the Board screen.
```

## 4 — Kanban board

```
Design the Kinynx Kanban board for the same Projects data and workflow. Columns =
stages with color dot, count and "n / limit" WIP badges (red when over).
Cards show title, owner avatar, points, due date (red if overdue) and tags.
Drag-and-drop between columns; illegal moves snap back with an inline toast that
quotes the server rule; legal moves animate and update the column counts.
Header: filters (owner, tag, due), swimlanes toggle (by owner), and a compact
report strip (Total, per-stage counts, Avg progress). Link to Insights.
```

## 5 — Dashboard builder

```
Design the Kinynx Insights dashboard "Projects overview" on a 4-column grid:
1) Delivery progress (completion %, throughput/week, overdue, stage meters with WIP),
2) Items by stage donut (stage colors), 3) Total points KPI hero number,
4) Points by owner stacked by stage (horizontal bars, legend + direct value labels),
5) Items created running total (area), 6) Work by tag table.
Every chart has hover tooltips, a ⋯ menu (Edit, Wider, Narrower, Duplicate, Remove)
and a table-view toggle for accessibility. Add a "+ Widget" side sheet: choose
visual, database, group by, date bucket, split by, measure (count/sum/avg/min/max
of a number), filters, running total, width — with a live preview that updates as
options change. Charts must be built from the Data grid's records (shared state).
```

## 6 — Progress tracking

```
Design the Kinynx Progress view for the Projects workflow over the last 30 days:
a hero "Complete %" tile, then tiles for Open items, Throughput/week, Lead time,
Cycle time, Overdue, and Forecast done date. Below: a burn-up chart (Scope vs Done
lines with crosshair tooltip), a Stages & WIP panel, and a "Completed per day"
column chart. A window switcher (14/30/90 days) recomputes everything.
Show a WIP-breach banner (warning icon + label) when a stage exceeds its limit.
Derive the numbers from a simulated event log (created / stage_changed) so they
stay consistent with the Board and Data screens.
```

## 7 — Report generator

```
Design the Kinynx report flow. From a dashboard, "Generate report" opens a dialog:
format (HTML / Markdown / CSV), date window, include sections (checkboxes for each
widget), and an optional summary paragraph. Show a print-ready preview: title,
"Generated <date> by <user>", KPI tiles, each chart drawn as static SVG with its
data table beneath, and a footer. Include "Download" and "Copy Markdown" actions,
plus a future "Schedule weekly to #channel / email" toggle shown as coming soon.
Make the preview read from the same dashboard state as screen 5.
```

## 8 — Customization center

```
Design the Kinynx "Customize workspace" center as a settings page with live
preview: theme (dark/light/system), accent color, density, chart palette (8 ordered
swatches with a color-blind safety check that warns if adjacent colors are too
similar), what you call a row ("Task", "Ticket", "Lead"), default dashboard,
which nav items show, date format, week start. A right-hand preview shows a mini
dashboard + board card updating instantly. Include "Reset to defaults".
```

## 9 — Everything linked (single prototype)

```
Combine screens 1–8 into ONE interactive Kinynx prototype with shared in-memory
state: the Data grid is the source of truth; the Workflow builder's rules gate
Board moves; Board moves append to an event log that drives Progress; Dashboard
widgets query the records; Reports render the current dashboard; Customization
re-themes everything live. Start with 25 seeded records and a 30-day event
history. Add a "Guided tour" button that walks: add a record → move it on the board
(one blocked by WIP) → see Progress update → add a chart widget → generate a report.
Keep it fast, keyboard accessible, and responsive down to 390px.
```

## Bonus prompts

- **Onboarding:** "Design a 3-step Kinynx onboarding: pick a template (Project
  tracker, CRM, Content calendar, Bug triage), name your stages, invite teammates —
  ending on a pre-built dashboard."
- **Template gallery:** "Design a Kinynx template gallery where each card previews
  its database fields, workflow stages and dashboard thumbnail; 'Use template' opens
  the linked prototype prefilled."
- **Mobile:** "Design Kinynx mobile (390px): bottom tab bar (Home, Board, Insights,
  Inbox), swipeable board columns, KPI carousel, and a quick-add sheet."
- **Gamified progress (optional):** "Add tasteful streaks and milestone badges to the
  Progress view — 'Shipped 10 items this week' — subtle, dismissible, never noisy."
