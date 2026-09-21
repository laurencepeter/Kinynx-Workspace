# Template Package Specification (`.template.zip`)

Templates are a **first-class, portable** feature. A template is a
self-contained ZIP archive. **A template never depends on the marketplace
server** — it can be created, exported, shared, and imported entirely offline.

## Package layout

```
my-template.template.zip
├── manifest.json          # required — metadata + integrity
├── content/
│   ├── pages.json         # page tree (blocks inline or referenced)
│   ├── databases.json     # database schemas + optional seed records
│   └── blocks/            # optional: large block payloads split out
├── assets/                # images/files referenced by content (relative paths)
│   └── <hash>.<ext>
├── screenshots/           # marketplace preview images (optional)
└── LICENSE                # template's own license (optional)
```

## `manifest.json`

```json
{
  "spec_version": "1.0",
  "id": "9d1f...",                    // stable UUID for updates/forks
  "name": "Product Roadmap",
  "version": "1.2.0",                 // semver; enables Update/Fork
  "description": "Quarterly roadmap with a linked bug tracker.",
  "author": { "name": "Jane Dev", "url": "https://..." },
  "category": "Product Roadmap",
  "tags": ["roadmap", "planning"],
  "kinynx_min_version": "0.1.0",
  "requires_features": [],            // e.g. ["databases"] — never enterprise-only for core templates
  "checksum": "sha256:...",           // over content/ + assets/
  "created_at": "2026-01-01T00:00:00Z"
}
```

## Content format

- **`pages.json`** — an array of pages with `parent` references (by local index
  or id) and their blocks. Block shape matches the API: `{ type, content,
  children? }`. IDs are re-generated on import.
- **`databases.json`** — database definitions: `properties` (typed), optional
  `views`, and optional seed `records`. Relation properties reference other
  databases in the same package by local id.
- **`assets/`** — content addresses assets by content hash; import uploads them
  to the workspace's object storage and rewrites references.

## Portability rules

1. **No server dependency.** Import must fully reconstruct the workspace content
   from the ZIP alone.
2. **Deterministic import.** Re-generate all IDs; preserve intra-package
   references via local ids.
3. **Integrity.** Importers verify `checksum` before applying; mismatches abort.
4. **Feature honesty.** Core templates must not require enterprise-only
   features. `requires_features` is validated against the deployment's
   entitlements; missing *core* features is a hard error, missing *optional*
   ones degrade gracefully.

## Lifecycle operations

`Create · Export · Download · Import · Update · Fork` — all operate on the ZIP.
`Update` bumps `version` and keeps `id`; `Fork` assigns a new `id` and records
`forked_from`. The marketplace (Phase 4) adds discovery, ratings, downloads,
versions, moderation — but templates remain downloadable without a paid account
and usable without the marketplace.
