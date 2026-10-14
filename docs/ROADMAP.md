# Product roadmap

Living checklist for the reference client and the API gaps it exposes. The API
already covered most capabilities (publishing, import/export, templates,
comments, realtime); the gap was mostly the web client. Tick items as they land.

## Phase 1 — Usable editor & management ✅ (this release)

- [x] Rename / delete **organizations** (owner-only delete, type-name confirmation, blocked by active legal hold)
- [x] Rename / delete **workspaces** (admin, type-name confirmation, audit-logged)
- [x] Rename / duplicate / archive **pages**; **sub-pages** (nested tree)
- [x] Inline-editable blocks (click to edit, autosave on blur)
- [x] **Checklists** you can tick off (persisted, strike-through when done)
- [x] **Divider** renders as a full-width rule
- [x] Headings (H1–H3), quotes, code, image & link blocks
- [x] Enter → new block (checklists continue as checklists), Backspace on empty → delete
- [x] Block menu: move up/down, turn into…, insert below, comment, delete
- [x] Slash shortcuts in the composer: `/h /h1 /todo /quote /code /hr /img /link`
- [x] **Authorship tracking**: each block records who added and last edited it
      (`blocks.created_by/updated_by`); per-user colours on blocks, contributor
      legend, presence avatars — toggle with 🎨 Authors
- [x] **Export**: Markdown, standalone HTML, PDF (print), Kinynx JSON (re-importable)
- [x] **Import**: `.template.zip`, Kinynx `.json`, Markdown `.md`
- [x] **Templates**: browse/search gallery, use, download `.template.zip`, save page as template
- [x] **Publish** read-only public page (`/p/<slug>`, optional password) + public viewer
- [x] Plan & features moved out of the page into the header **✦ Pro** modal
- [x] Invite links (`/invite/<token>`), magic sign-in and password-reset links now resolve
      (token scrubbed from the address bar; invite auto-accepted after sign-in)
- [x] Access token auto-refresh (sessions no longer break after 15 min)
- [x] Web security headers (CSP, nosniff, no-referrer, frame-ancestors none)
- [x] Worker container healthcheck (was always "unhealthy")

## Phase 1.5 — Office-style editor ✅

- [x] **Formatting toolbar** with three levels — Basic → Advanced → Expert (remembered per browser)
- [x] **🧰 All tools** catalog: every tool, its level, shortcut and plan (all editor tools are free)
- [x] Inline formatting: bold, italic, underline, strikethrough, highlight, text colour, font, size, super/subscript, links, clear formatting
      — powered by **Tiptap v3 / ProseMirror** (schema-checked; no deprecated `document.execCommand`)
- [x] Block formatting: align left/center/right/justify, indent, line spacing, background, borders/outlines (style, colour, width, corners, padding), format painter
- [x] **Tables**: insert any size, Tab between cells, add/delete rows & columns, header row, stripes, border style/colour, header colour, column alignment
- [x] Bulleted & numbered lists, callouts; Enter continues a list, Enter on an empty item ends it
- [x] **Drag & drop** block reordering (mouse, touch, pen) + Alt+Shift+↑/↓
- [x] **Sign**: draw or type a signature; signer + time stamped server-side. Freehand **drawing** blocks (vector)
- [x] Find & replace (keeps formatting), word count, keyboard shortcut sheet
- [x] Markdown import/export for tables and lists; HTML/PDF export keeps formatting

## Phase 2 — Collaboration depth

- [ ] Email confirmation on sign-up (`email_verified_at`, verify link via the email driver — Mailjet supported: `EMAIL_DRIVER=mailjet`)
- [ ] Per-page sharing UI (page-level roles exist in `page_permissions`; needs endpoints + UI)
- [ ] "Suggest edits" mode for published pages (viewers propose changes, editors accept)
- [ ] Activity feed / page history UI (version snapshot + restore endpoints already exist)
- [ ] @mentions in comments and blocks (API supports `mentions[]`)
- [ ] Live cursors / per-user caret colours (presence channel exists)
- [ ] Trash view with restore + permanent delete for archived pages

## Phase 3 — Dynamic pages

- [ ] Database blocks embedded in pages (table / board / calendar views — API exists)
- [ ] Linked/synced blocks and `@page` links with backlinks panel
- [ ] Template variables (`{{date}}`, `{{user}}`) filled on import
- [ ] Toggle lists, callouts, columns, tables
- [ ] Drag-and-drop block reordering
- [ ] File/image upload blocks (files API exists)
- [ ] Rich text marks (bold/italic/links/inline code) within blocks

## Phase 4 — Hardening & polish

- [ ] Move refresh token from `localStorage` to an HttpOnly, SameSite=Strict cookie
- [ ] Light theme + theme toggle
- [ ] Keyboard command palette (⌘K) with search
- [ ] Mobile layout pass for the editor
- [ ] Offline-tolerant edit queue

## Template file format

Author your own templates as a `.template.zip` (manifest.json + content/page.json)
or a plain Kinynx JSON export — see [TEMPLATE_SPEC.md](TEMPLATE_SPEC.md). Markdown
files also import (headings, `- [ ]` checklists, `>` quotes, fenced code, `---`).
