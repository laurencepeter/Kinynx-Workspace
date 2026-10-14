// Editor tools for the reference client: formatting toolbar (Basic → Advanced →
// Expert tiers), the full tool catalog, drag-and-drop block reordering, the
// signature/drawing pad, find & replace and document statistics.
// Loaded after app.js and uses its globals (state, h, R, api helpers, …).
// SECURITY: formatting is applied with execCommand / CSSOM inside the editor;
// what gets stored is re-sanitised by R.cleanRich and R.applyStyle on render.
(function () {
  const TIERS = ["basic", "advanced", "expert"];
  const TIER_LABEL = { basic: "Basic", advanced: "Advanced", expert: "Expert" };
  let tier = (() => { try { return TIERS.includes(localStorage.getItem("kinynx_tier")) ? localStorage.getItem("kinynx_tier") : "basic"; } catch { return "basic"; } })();

  // ── Selection & active block bookkeeping ──────────────────────────────────
  let savedRange = null;
  document.addEventListener("selectionchange", () => {
    const sel = getSelection();
    if (!sel.rangeCount) return;
    const node = sel.anchorNode;
    const ed = (node?.nodeType === 1 ? node : node?.parentElement)?.closest?.("#blocks .ed");
    if (ed) { savedRange = sel.getRangeAt(0).cloneRange(); syncPressed(); }
  });
  const activeBlock = () => (state.activeBlock && state.blocks.includes(state.activeBlock) ? state.activeBlock : null);
  const blockNode = (b) => $("blocks").querySelector(`.blk[data-id="${CSS.escape(b.id)}"]`);
  const edOf = (b) => blockNode(b)?.querySelector(".ed");

  function restoreSelection() {
    if (!savedRange || !document.contains(savedRange.startContainer)) return null;
    const ed = (savedRange.startContainer.nodeType === 1 ? savedRange.startContainer : savedRange.startContainer.parentElement).closest(".ed");
    if (!ed) return null;
    ed.focus({ preventScroll: true });
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);
    return ed;
  }
  const hasSelection = () => savedRange && !savedRange.collapsed && document.contains(savedRange.startContainer);

  // Save whatever is being typed in a block before changing it structurally.
  async function flush(b) {
    const ed = b && edOf(b);
    if (ed && ed.classList.contains("cell")) ed.blur();
    else if (ed) await saveEd(b, ed);
  }

  function inline(cmd, value) {
    const ed = restoreSelection();
    if (!ed) { toast("Select some text in a block first"); return false; }
    if (ed.contentEditable !== "true" || ed.classList.contains("cell")) { toast("This block is plain text"); return false; }
    document.execCommand("styleWithCSS", false, true);
    document.execCommand(cmd, false, value);
    savedRange = getSelection().rangeCount ? getSelection().getRangeAt(0).cloneRange() : null;
    syncPressed();
    return true;
  }

  // Style changes read-modify-write a block, so run them one at a time:
  // two quick clicks must not overwrite each other.
  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn, fn));
  const blockStyle = (patch) => serial(() => applyBlockStyle(patch));
  const tOp = (b, op, v) => serial(() => tableOp(b, op, v));

  async function applyBlockStyle(patch) {
    const b = activeBlock();
    if (!b) { toast("Click into a block first"); return; }
    await flush(b);
    const style = { ...(b.content?.style || {}) };
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === "") delete style[k]; else style[k] = v; }
    const content = { ...b.content };
    if (Object.keys(style).length) content.style = style; else delete content.style;
    await patchBlock(b, { content });
    refreshBlock(b);
    edOf(b)?.focus({ preventScroll: true });
  }

  async function turnInto(type, extra = {}) {
    const b = activeBlock();
    if (!b || !TEXT_TYPES.has(b.type)) { toast("Click into a text block first"); return; }
    await flush(b);
    const c = b.content || {};
    const content = { text: R.textOf(b), ...(c.style ? { style: c.style } : {}), ...(type !== "code" && c.rich ? { rich: c.rich } : {}), ...extra };
    if (type === "checklist") content.checked = !!c.checked;
    await patchBlock(b, { type, content });
    renderBlocks();
    edOf(b)?.focus({ preventScroll: true });
  }

  async function insert(type, content = {}) {
    if (!state.pageId) return;
    const b = activeBlock();
    if (b) await flush(b);
    return insertBlockAfter(b, type, content);
  }

  // ── Tool registry: one list drives the toolbar AND the catalog ────────────
  // plan: every editor tool is free. See the catalog footer for licence terms.
  const COLORS = ["#e7e9f0", "#9aa0b4", "#f87171", "#fb923c", "#facc15", "#34d399", "#22d3ee", "#60a5fa", "#a78bfa", "#f472b6", "#1d1f27"];
  const TOOLS = [
    // Basic
    { id: "undo", group: "History", tier: "basic", icon: "↶", label: "Undo", keys: "Ctrl+Z", run: () => inline("undo") },
    { id: "redo", group: "History", tier: "basic", icon: "↷", label: "Redo", keys: "Ctrl+Y", run: () => inline("redo") },
    { id: "style", group: "Text", tier: "basic", kind: "style", label: "Paragraph style", desc: "Text, headings, quote, lists, code…" },
    { id: "bold", group: "Text", tier: "basic", icon: "B", css: "font-weight:800", label: "Bold", keys: "Ctrl+B", cmd: "bold", run: () => inline("bold") },
    { id: "italic", group: "Text", tier: "basic", icon: "I", css: "font-style:italic", label: "Italic", keys: "Ctrl+I", cmd: "italic", run: () => inline("italic") },
    { id: "underline", group: "Text", tier: "basic", icon: "U", css: "text-decoration:underline", label: "Underline", keys: "Ctrl+U", cmd: "underline", run: () => inline("underline") },
    { id: "color", group: "Text", tier: "basic", kind: "color", icon: "A", label: "Text colour", desc: "Colours the selection, or the whole block if nothing is selected",
      apply: (v) => (hasSelection() && v ? inline("foreColor", v) : blockStyle({ color: v })) },
    { id: "alignLeft", group: "Paragraph", tier: "basic", icon: "⇤", label: "Align left", align: "left", run: () => align("left") },
    { id: "alignCenter", group: "Paragraph", tier: "basic", icon: "↔", label: "Center", keys: "Ctrl+E", align: "center", run: () => align("center") },
    { id: "alignRight", group: "Paragraph", tier: "basic", icon: "⇥", label: "Align right", align: "right", run: () => align("right") },
    { id: "bullets", group: "Insert", tier: "basic", icon: "•≡", label: "Bulleted list", desc: "Also: type /ul", run: () => listToggle("bulleted_list") },
    { id: "numbers", group: "Insert", tier: "basic", icon: "1≡", label: "Numbered list", desc: "Also: type /ol", run: () => listToggle("numbered_list") },
    { id: "check", group: "Insert", tier: "basic", icon: "☑", label: "Checklist", run: () => listToggle("checklist") },
    { id: "table", group: "Insert", tier: "basic", icon: "▦", label: "Table", desc: "Tab moves between cells; Tab on the last cell adds a row", run: () => insertTable() },
    { id: "link", group: "Insert", tier: "basic", icon: "🔗", label: "Link", keys: "Ctrl+K", run: () => addLink() },
    { id: "sign", group: "Insert", tier: "basic", icon: "✍", label: "Sign", desc: "Draw or type a signature; signer and time are stamped by the server", run: () => openInkPad("signature") },
    // Advanced
    { id: "strike", group: "Text", tier: "advanced", icon: "S", css: "text-decoration:line-through", label: "Strikethrough", cmd: "strikeThrough", run: () => inline("strikeThrough") },
    { id: "highlight", group: "Text", tier: "advanced", kind: "color", icon: "🖍", label: "Highlight", value: "#facc15", apply: (v) => inline("hiliteColor", v || "transparent") },
    { id: "font", group: "Text", tier: "advanced", kind: "select", label: "Font", options: [["", "Font"], ["sans", "Sans"], ["serif", "Serif"], ["mono", "Mono"], ["rounded", "Rounded"], ["hand", "Handwriting"]],
      apply: (v) => v && (hasSelection() ? inline("fontName", R.FONTS[v]) : blockStyle({ font: v })) },
    { id: "size", group: "Text", tier: "advanced", kind: "select", label: "Size", options: [["", "Size"], ["12px", "12"], ["14px", "14"], ["16px", "16"], ["18px", "18"], ["22px", "22"], ["28px", "28"], ["36px", "36"], ["48px", "48"]],
      apply: (v) => v && (hasSelection() ? inline("fontSize", { "12px": 1, "14px": 2, "16px": 3, "18px": 4, "22px": 5, "28px": 6, "36px": 7, "48px": 7 }[v]) : blockStyle({ size: v })) },
    { id: "sup", group: "Text", tier: "advanced", icon: "x²", label: "Superscript", cmd: "superscript", run: () => inline("superscript") },
    { id: "sub", group: "Text", tier: "advanced", icon: "x₂", label: "Subscript", cmd: "subscript", run: () => inline("subscript") },
    { id: "clear", group: "Text", tier: "advanced", icon: "⌫", label: "Clear formatting", desc: "Removes inline formatting from the selection, or all styling from the block", run: () => clearFormatting() },
    { id: "justify", group: "Paragraph", tier: "advanced", icon: "☰", label: "Justify", align: "justify", run: () => align("justify") },
    { id: "outdent", group: "Paragraph", tier: "advanced", icon: "⇠", label: "Decrease indent", run: () => indent(-1) },
    { id: "indent", group: "Paragraph", tier: "advanced", icon: "⇢", label: "Increase indent", run: () => indent(1) },
    { id: "lineHeight", group: "Paragraph", tier: "advanced", kind: "select", label: "Line spacing", options: [["", "Spacing"], ["1", "1.0"], ["1.15", "1.15"], ["1.5", "1.5"], ["2", "2.0"], ["2.5", "2.5"]],
      apply: (v) => blockStyle({ lineHeight: v ? Number(v) : null }) },
    { id: "fill", group: "Block", tier: "advanced", kind: "color", icon: "▣", label: "Block background", value: "#1e2130", apply: (v) => blockStyle({ bg: v }) },
    { id: "border", group: "Block", tier: "advanced", kind: "select", label: "Border / outline", options: [["", "Border"], ["none", "None"], ["solid", "Solid"], ["dashed", "Dashed"], ["dotted", "Dotted"], ["double", "Double"]],
      apply: (v) => v && (activeBlock()?.type === "table" ? tOp(activeBlock(), "border", v) : blockStyle({ border: v === "none" ? null : v })) },
    { id: "borderColor", group: "Block", tier: "advanced", kind: "color", icon: "▢", label: "Border colour", value: "#6d5efc",
      apply: (v) => (activeBlock()?.type === "table" ? tOp(activeBlock(), "borderColor", v) : blockStyle({ borderColor: v, border: v ? activeBlock()?.content?.style?.border || "solid" : undefined })) },
    { id: "quote", group: "Insert", tier: "advanced", icon: "❝", label: "Quote", run: () => insert("quote", { text: "" }) },
    { id: "callout", group: "Insert", tier: "advanced", icon: "💡", label: "Callout", run: () => insert("callout", { text: "", icon: "💡" }) },
    { id: "code", group: "Insert", tier: "advanced", icon: "</>", label: "Code block", run: () => insert("code", { text: "" }) },
    { id: "divider", group: "Insert", tier: "advanced", icon: "―", label: "Divider", run: () => insert("divider") },
    { id: "image", group: "Insert", tier: "advanced", icon: "🖼", label: "Image (URL)", run: () => insertImage() },
    // Expert
    { id: "borderWidth", group: "Block", tier: "expert", kind: "select", label: "Border width", options: [["", "Width"], ["1", "1px"], ["2", "2px"], ["3", "3px"], ["4", "4px"], ["6", "6px"]],
      apply: (v) => blockStyle({ borderWidth: v ? Number(v) : null }) },
    { id: "radius", group: "Block", tier: "expert", kind: "select", label: "Corner radius", options: [["", "Corners"], ["0", "Square"], ["6", "Soft"], ["12", "Round"], ["24", "Pill"]],
      apply: (v) => blockStyle({ radius: v === "" ? null : Number(v) }) },
    { id: "padding", group: "Block", tier: "expert", kind: "select", label: "Padding", options: [["", "Padding"], ["0", "None"], ["8", "S"], ["16", "M"], ["24", "L"], ["40", "XL"]],
      apply: (v) => blockStyle({ padding: v === "" ? null : Number(v) }) },
    { id: "copyStyle", group: "Block", tier: "expert", icon: "🖌", label: "Copy style", desc: "Format painter: copy this block's style…", run: () => copyStyle() },
    { id: "pasteStyle", group: "Block", tier: "expert", icon: "🖌⤵", label: "Paste style", desc: "…and apply it to another block", run: () => pasteStyle() },
    { id: "tableRow", group: "Table", tier: "expert", icon: "⊞↓", label: "Add table row", run: () => withTable((b) => tOp(b, "addRow")) },
    { id: "tableCol", group: "Table", tier: "expert", icon: "⊞→", label: "Add table column", run: () => withTable((b) => tOp(b, "addCol")) },
    { id: "tableDelRow", group: "Table", tier: "expert", icon: "⊟↓", label: "Delete table row", run: () => withTable((b) => tOp(b, "delRow")) },
    { id: "tableDelCol", group: "Table", tier: "expert", icon: "⊟→", label: "Delete table column", run: () => withTable((b) => tOp(b, "delCol")) },
    { id: "tableHeader", group: "Table", tier: "expert", icon: "▤", label: "Toggle header row", run: () => withTable((b) => tOp(b, "header")) },
    { id: "tableStripe", group: "Table", tier: "expert", icon: "▥", label: "Toggle striped rows", run: () => withTable((b) => tOp(b, "striped")) },
    { id: "headerBg", group: "Table", tier: "expert", kind: "color", icon: "▀", label: "Header colour", value: "#2a2e3f", apply: (v) => withTable((b) => tOp(b, "headerBg", v)) },
    { id: "draw", group: "Insert", tier: "expert", icon: "✏️", label: "Drawing", desc: "Freehand sketch (vector, scales cleanly)", run: () => openInkPad("drawing") },
    { id: "find", group: "Review", tier: "expert", icon: "🔍", label: "Find & replace", keys: "Ctrl+H", run: () => findReplace() },
    { id: "stats", group: "Review", tier: "expert", icon: "#", label: "Word count", run: () => wordCount() },
    { id: "shortcuts", group: "Review", tier: "expert", icon: "⌨", label: "Keyboard shortcuts", run: () => shortcuts() },
  ];
  // Not toolbar buttons, but part of the suite — listed in the catalog.
  const EXTRAS = [
    { group: "Layout", tier: "basic", icon: "⋮⋮", label: "Drag & drop to reorder", desc: "Drag a block's ⋮⋮ handle; Alt+Shift+↑/↓ from the keyboard" },
    { group: "Layout", tier: "basic", icon: "⧉", label: "Duplicate block", desc: "Block menu (⋮⋮ → Duplicate)" },
    { group: "Text", tier: "basic", icon: "H", label: "Headings 1–3", desc: "Paragraph style menu, or /h" },
    { group: "Share", tier: "basic", icon: "⤓", label: "Export: Markdown, HTML, PDF, JSON", desc: "Export button above the page" },
    { group: "Share", tier: "basic", icon: "🌐", label: "Publish to the web", desc: "Read-only link, optional password" },
    { group: "Review", tier: "basic", icon: "💬", label: "Comments", desc: "Page and block comments" },
    { group: "Review", tier: "basic", icon: "🎨", label: "Author colours", desc: "See who wrote what" },
  ];

  // ── Toolbar ───────────────────────────────────────────────────────────────
  const keep = (e) => e.preventDefault(); // keep the caret/selection in the block
  const controls = new Map();

  function buildToolbar() {
    const bar = $("fmtBar");
    const seg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Tool level" },
      TIERS.map((t) => h("button", { type: "button", role: "radio", "data-t": t, "aria-checked": String(t === tier), onmousedown: keep,
        onclick: () => setTier(t) }, TIER_LABEL[t])));
    const groups = new Map();
    for (const t of TOOLS) {
      const el = control(t);
      el.dataset.tier = t.tier;
      controls.set(t.id, el);
      if (!groups.has(t.group)) groups.set(t.group, h("div", { class: "fmt-group", role: "group", "aria-label": t.group }));
      groups.get(t.group).append(el);
    }
    const all = h("button", { type: "button", class: "ghost fmt-all", onclick: openCatalog, title: "Every tool, by level" }, "🧰 All tools");
    bar.replaceChildren(h("div", { class: "fmt-top" }, seg, h("span", { class: "spacer" }), all), h("div", { class: "fmt-tools" }, [...groups.values()]));
    applyTier();
  }

  function control(t) {
    const title = `${t.label}${t.keys ? ` (${t.keys})` : ""}${t.desc ? ` — ${t.desc}` : ""}`;
    if (t.kind === "color") {
      const bar = h("span", { class: "bar", style: `background:${t.value || "#f87171"}` });
      const btn = h("button", { type: "button", class: "fmt-btn fmt-color", title, "aria-label": t.label, "aria-haspopup": "true", onmousedown: keep,
        onclick: () => swatchMenu(btn, t, (c) => { if (c) bar.style.background = c; }) }, h("span", {}, t.icon), bar);
      return btn;
    }
    if (t.kind === "select" || t.kind === "style") {
      const opts = t.kind === "style"
        ? [["", "Style"], ["paragraph", "Normal text"], ["heading:1", "Heading 1"], ["heading:2", "Heading 2"], ["heading:3", "Heading 3"],
           ["quote", "Quote"], ["callout", "Callout"], ["bulleted_list", "Bulleted list"], ["numbered_list", "Numbered list"], ["checklist", "Checklist"], ["code", "Code"]]
        : t.options;
      const sel = h("select", { "aria-label": t.label, title, class: "fmt-select" }, opts.map(([v, l]) => h("option", { value: v }, l)));
      sel.addEventListener("change", async () => {
        const v = sel.value;
        sel.value = "";
        if (t.kind === "style") { if (v) { const [type, lv] = v.split(":"); await turnInto(type, lv ? { level: Number(lv) } : {}); } }
        else await t.apply(v);
      });
      return sel;
    }
    return h("button", { type: "button", class: "fmt-btn", title, "aria-label": t.label, onmousedown: keep, onclick: () => t.run() },
      h("span", { style: t.css || "" }, t.icon));
  }

  function swatchMenu(anchor, t, onPick) {
    document.querySelectorAll(".menu").forEach((m) => m.remove());
    const r = anchor.getBoundingClientRect();
    const pick = (c) => { menu.remove(); onPick(c); t.apply(c); };
    const custom = h("input", { type: "color", value: t.value || "#f87171", "aria-label": "Custom colour", style: "width:100%;height:30px;padding:2px" });
    custom.addEventListener("change", () => pick(custom.value));
    const menu = h("div", { class: "menu swatch-menu", role: "dialog", "aria-label": t.label,
      style: `top:${r.bottom + scrollY + 4}px;left:${Math.min(r.left + scrollX, innerWidth - 200)}px` },
      h("div", { class: "small muted", style: "padding:2px 4px 6px" }, t.label),
      h("div", { class: "swatches" }, COLORS.map((c) => h("button", { type: "button", class: "sw", style: `background:${c}`, title: c, "aria-label": c, onmousedown: keep, onclick: () => pick(c) }))),
      custom,
      h("button", { type: "button", onmousedown: keep, onclick: () => pick("") }, "Default / none"));
    menu.addEventListener("click", (e) => e.stopPropagation());
    document.body.append(menu);
    setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }), 0);
  }

  function setTier(t) {
    tier = t;
    try { localStorage.setItem("kinynx_tier", t); } catch {}
    applyTier();
  }
  function applyTier() {
    const max = TIERS.indexOf(tier);
    for (const el of controls.values()) el.classList.toggle("hidden", TIERS.indexOf(el.dataset.tier) > max);
    $("fmtBar").querySelectorAll(".fmt-group").forEach((g) => g.classList.toggle("hidden", ![...g.children].some((c) => !c.classList.contains("hidden"))));
    $("fmtBar").querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.t === tier)));
  }

  // Reflect bold/italic/… and alignment of the current selection/block.
  function syncPressed() {
    for (const t of TOOLS) {
      const el = controls.get(t.id);
      if (!el) continue;
      if (t.cmd) { let on = false; try { on = document.queryCommandState(t.cmd); } catch {} el.setAttribute("aria-pressed", String(on)); }
      if (t.align) el.setAttribute("aria-pressed", String((activeBlock()?.content?.style?.align || "left") === t.align));
    }
  }
  $("blocks").addEventListener("focusin", syncPressed);

  // Autosave while typing (also lets collaborators see edits sooner).
  let saveTimer = null;
  $("blocks").addEventListener("input", (e) => {
    const ed = e.target.closest?.(".ed");
    const b = activeBlock();
    if (!ed || ed.classList.contains("cell") || !b) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { if (document.contains(ed)) saveEd(b, ed); }, 1200);
  });

  // ── Tool implementations ──────────────────────────────────────────────────
  async function align(v) {
    const b = activeBlock();
    if (b?.type === "table") return tOp(b, "alignCol", v);
    await blockStyle({ align: v === "left" ? null : v });
    syncPressed();
  }
  async function indent(d) {
    const cur = Number(activeBlock()?.content?.style?.indent) || 0;
    const next = Math.max(0, Math.min(8, cur + d));
    await blockStyle({ indent: next || null });
  }
  async function listToggle(type) {
    const b = activeBlock();
    if (b && TEXT_TYPES.has(b.type) && b.type !== "code") return turnInto(b.type === type ? "paragraph" : type);
    await insert(type, type === "checklist" ? { text: "", checked: false } : { text: "" });
  }
  async function insertTable() {
    const size = await promptText("Insert table", "Columns × rows (max 20 × 100)", "3x3", { maxlength: 9 });
    if (!size) return;
    const m = size.match(/^\s*(\d{1,2})\s*[x×*,]\s*(\d{1,3})\s*$/i);
    if (!m) { toast("Use the form 3x4"); return; }
    const cols = Math.min(R.MAX_COLS, Math.max(1, +m[1])), rows = Math.min(R.MAX_ROWS, Math.max(1, +m[2]));
    await insert("table", { rows: Array.from({ length: rows }, () => Array(cols).fill("")), header: true });
  }
  async function addLink() {
    const range = hasSelection() ? savedRange.cloneRange() : null;
    const raw = await promptText("Insert link", "https:// address", "", { maxlength: 2000 });
    if (!raw) return;
    const url = R.safeUrl(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!url) { toast("Enter an http(s) URL"); return; }
    if (range) { savedRange = range; inline("createLink", url); }
    else await insert("embed", { url, text: url });
  }
  async function insertImage() {
    const raw = await promptText("Insert image", "Image URL (https://…)", "", { maxlength: 2000 });
    if (!raw) return;
    const url = R.safeUrl(raw);
    if (!url) { toast("Enter an http(s) URL"); return; }
    await insert("image", { url, text: "" });
  }
  async function clearFormatting() {
    if (hasSelection()) { inline("removeFormat"); inline("unlink"); return; }
    const b = activeBlock();
    if (!b) { toast("Click into a block first"); return; }
    const content = { ...b.content };
    delete content.style; delete content.rich;
    await patchBlock(b, { content });
    refreshBlock(b);
  }
  let copiedStyle = null;
  function copyStyle() {
    const b = activeBlock();
    if (!b) { toast("Click into a block first"); return; }
    copiedStyle = structuredClone(b.content?.style || {});
    toast("Style copied — click another block, then 🖌⤵ Paste style");
  }
  async function pasteStyle() {
    if (!copiedStyle) { toast("Copy a style first (🖌)"); return; }
    const b = activeBlock();
    if (!b) { toast("Click into a block first"); return; }
    await flush(b);
    const content = { ...b.content, style: copiedStyle };
    if (!Object.keys(copiedStyle).length) delete content.style;
    await patchBlock(b, { content });
    refreshBlock(b);
  }
  function withTable(fn) {
    const b = activeBlock();
    if (b?.type !== "table") { toast("Click into a table cell first"); return; }
    return fn(b);
  }

  // ── Catalog of every tool (Basic / Advanced / Expert, Free) ──────────────
  function openCatalog() {
    const q = h("input", { type: "search", placeholder: "Search tools…", "aria-label": "Search tools" });
    const list = h("div", { class: "catalog" });
    const rows = [...TOOLS, ...EXTRAS];
    const draw = () => {
      const term = q.value.trim().toLowerCase();
      list.replaceChildren(...TIERS.map((t) => {
        const items = rows.filter((r) => r.tier === t && (!term || `${r.label} ${r.group} ${r.desc || ""}`.toLowerCase().includes(term)));
        if (!items.length) return null;
        return h("section", {},
          h("h4", {}, TIER_LABEL[t], h("span", { class: "small muted" }, ` · ${items.length} tools`)),
          h("table", { class: "cat-table" }, h("tbody", {}, items.map((r) => h("tr", {},
            h("td", { class: "cat-ic" }, r.icon || "•"),
            h("td", {}, h("b", {}, r.label), r.desc ? h("div", { class: "small muted" }, r.desc) : null),
            h("td", { class: "small muted" }, r.group),
            h("td", { class: "small muted" }, r.keys || ""),
            h("td", {}, h("span", { class: "chip on" }, "Free")))))));
      }).filter(Boolean));
    };
    q.addEventListener("input", draw);
    draw();
    const show = h("div", { class: "row", style: "flex-wrap:wrap" }, h("span", { class: "small muted" }, "Show in toolbar:"),
      TIERS.map((t) => h("button", { type: "button", class: t === tier ? "" : "ghost", style: "padding:5px 10px", onclick: () => { setTier(t); $("dlg").close(); } }, TIER_LABEL[t])));
    dialog("All tools", h("div", { class: "stack" }, q, show, list,
      h("p", { class: "small muted", style: "margin:0" },
        "Every editor tool is free. The Kinynx core is Apache-2.0 — free for personal and commercial use when self-hosted. ",
        "Enterprise administration features (SSO, SCIM, audit retention…) are listed under ✦ Plan.")),
      [{ label: "Close", value: undefined }]);
    $("dlg").classList.add("wide");
    $("dlg").addEventListener("close", () => $("dlg").classList.remove("wide"), { once: true });
  }

  // ── Find & replace ────────────────────────────────────────────────────────
  function findReplace() {
    const find = h("input", { placeholder: "Find", "aria-label": "Find" });
    const repl = h("input", { placeholder: "Replace with", "aria-label": "Replace with" });
    const cs = h("input", { type: "checkbox", style: "width:auto" });
    const info = h("p", { class: "small muted", style: "margin:0" }, "");
    const rx = () => find.value && new RegExp(find.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), cs.checked ? "g" : "gi");
    const count = () => {
      const r = rx();
      let n = 0;
      if (r) for (const b of state.blocks) for (const t of texts(b)) n += (t.match(r) || []).length;
      info.textContent = r ? `${n} match${n === 1 ? "" : "es"}` : "";
    };
    find.addEventListener("input", count); cs.addEventListener("change", count);
    dialog("Find & replace", h("div", { class: "stack" }, find, repl, h("label", { class: "row small" }, cs, "Match case"), info), [
      { label: "Close", value: undefined },
      { label: "Replace all", submit: true, value: () => ({ r: rx(), to: repl.value }) },
    ]).then(async (v) => {
      if (!v?.r) return;
      let changed = 0;
      for (const b of [...state.blocks]) {
        const c = b.content || {};
        let next = null;
        if (b.type === "table") {
          const rows = R.tableRows(c).map((row) => row.map((x) => x.replace(v.r, () => v.to)));
          if (JSON.stringify(rows) !== JSON.stringify(R.tableRows(c))) next = { ...c, rows };
        } else if (TEXT_TYPES.has(b.type) || b.type === "image" || b.type === "embed") {
          const key = b.type === "code" && c.code !== undefined ? "code" : "text";
          const t = String(c[key] ?? "");
          if (v.r.test(t)) {
            v.r.lastIndex = 0;
            next = { ...c, [key]: t.replace(v.r, () => v.to) };
            if (c.rich) { // replace inside text nodes so formatting survives
              const box = h("div"); box.append(R.richFragment(c.rich));
              const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
              for (let n; (n = walker.nextNode());) n.data = n.data.replace(v.r, () => v.to);
              next.rich = R.cleanRich(box.innerHTML);
            }
          }
          v.r.lastIndex = 0;
        }
        if (next) { await patchBlock(b, { content: next }).catch(() => {}); changed++; }
      }
      renderBlocks();
      toast(changed ? `Replaced in ${changed} block${changed === 1 ? "" : "s"}` : "No matches");
    });
  }
  function texts(b) {
    if (b.type === "table") return R.tableRows(b.content).flat();
    return [R.textOf(b)];
  }

  function wordCount() {
    const all = state.blocks.flatMap(texts).join("\n");
    const words = (all.match(/\S+/g) || []).length;
    const stat = (k, v) => h("div", { class: "tpl" }, h("span", {}, k), h("b", {}, String(v)));
    dialog("Word count", h("div", { class: "stack" },
      stat("Words", words), stat("Characters", all.replace(/\n/g, "").length), stat("Characters (no spaces)", all.replace(/\s/g, "").length),
      stat("Blocks", state.blocks.length), stat("Reading time", `${Math.max(1, Math.round(words / 230))} min`)), [{ label: "Close", value: undefined }]);
  }

  function shortcuts() {
    const rows = [["Bold / Italic / Underline", "Ctrl+B / I / U"], ["Center block", "Ctrl+E"], ["Link", "Ctrl+K"], ["Find & replace", "Ctrl+H"],
      ["New block (same list type)", "Enter"], ["Line break inside a block", "Shift+Enter"], ["End a list", "Enter on an empty item"],
      ["Delete empty block", "Backspace"], ["Move block", "Alt+Shift+↑ / ↓  or drag ⋮⋮"], ["Next / previous table cell", "Tab / Shift+Tab"]];
    dialog("Keyboard shortcuts", h("table", { class: "cat-table" }, h("tbody", {}, rows.map(([a, k]) => h("tr", {}, h("td", {}, a), h("td", {}, h("kbd", {}, k)))))),
      [{ label: "Close", value: undefined }]);
  }

  // Shortcuts not handled natively by contentEditable.
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || !state.pageId || $("dlg").open) return;
    const inEd = document.activeElement?.closest?.("#blocks .ed");
    const k = e.key.toLowerCase();
    if (k === "h") { e.preventDefault(); findReplace(); }
    else if (inEd && k === "e") { e.preventDefault(); align(activeBlock()?.content?.style?.align === "center" ? "left" : "center"); }
    else if (inEd && k === "k") { e.preventDefault(); addLink(); }
  });

  // ── Signature / drawing pad (vector strokes, no image upload needed) ─────
  function openInkPad(type, existing) {
    const sign = type === "signature";
    const W = 600, H = sign ? 200 : 360;
    const canvas = h("canvas", { width: W, height: H, class: "inkpad", "aria-label": sign ? "Signature pad" : "Drawing pad" });
    const ctx = canvas.getContext("2d");
    const prev = existing?.content || {};
    let strokes = Array.isArray(prev.strokes) && !prev.typed ? prev.strokes.map((s) => [...s]) : [];
    let color = sign ? "#1d1f27" : (prev.color || "#6d5efc");
    let width = Number(prev.width) || (sign ? 2.5 : 3);
    const redraw = () => {
      ctx.clearRect(0, 0, W, H);
      ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = color; ctx.lineWidth = width;
      if (sign) { ctx.save(); ctx.strokeStyle = "#c7cad6"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(30, H - 40); ctx.lineTo(W - 30, H - 40); ctx.stroke(); ctx.restore(); }
      for (const s of strokes) {
        ctx.beginPath(); ctx.moveTo(s[0], s[1]);
        for (let i = 2; i < s.length; i += 2) ctx.lineTo(s[i], s[i + 1]);
        if (s.length === 2) ctx.lineTo(s[0] + 0.1, s[1]);
        ctx.stroke();
      }
    };
    let cur = null;
    const pt = (e) => { const r = canvas.getBoundingClientRect(); return [Math.round(((e.clientX - r.left) * W) / r.width * 10) / 10, Math.round(((e.clientY - r.top) * H) / r.height * 10) / 10]; };
    canvas.addEventListener("pointerdown", (e) => { canvas.setPointerCapture(e.pointerId); cur = pt(e); strokes.push(cur); redraw(); });
    canvas.addEventListener("pointermove", (e) => {
      if (!cur) return;
      const [x, y] = pt(e), lx = cur[cur.length - 2], ly = cur[cur.length - 1];
      if (Math.hypot(x - lx, y - ly) < 1.5 || cur.length > 4000) return;
      cur.push(x, y); redraw();
    });
    const end = () => { cur = null; };
    canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end);

    const typed = h("input", { placeholder: "…or type your full name", maxlength: "120", value: prev.typed || "", "aria-label": "Typed signature" });
    const preview = h("div", { class: "k-sign-typed inkpad", style: "min-height:56px;padding:6px 12px" }, prev.typed || "");
    typed.addEventListener("input", () => { preview.textContent = typed.value; });
    const caption = h("input", { placeholder: "Caption (optional)", maxlength: "200", value: prev.text || "", "aria-label": "Caption" });
    const colorIn = h("input", { type: "color", value: color, style: "width:44px;padding:2px", "aria-label": "Pen colour" });
    colorIn.addEventListener("input", () => { color = colorIn.value; redraw(); });
    const widthIn = h("select", { style: "width:auto", "aria-label": "Pen width" }, [1.5, 2.5, 4, 6, 9].map((w) => h("option", { value: w, selected: w === width }, `${w}px`)));
    widthIn.addEventListener("change", () => { width = Number(widthIn.value); redraw(); });
    const tools = h("div", { class: "row", style: "flex-wrap:wrap" },
      h("button", { type: "button", class: "ghost", onclick: () => { strokes.pop(); redraw(); } }, "↶ Undo stroke"),
      h("button", { type: "button", class: "ghost", onclick: () => { strokes = []; redraw(); } }, "Clear"),
      sign ? null : colorIn, sign ? null : widthIn);
    const body = h("div", { class: "stack" },
      h("div", { class: "inkpad-wrap" }, canvas), tools,
      sign ? h("div", { class: "stack" }, typed, preview,
        h("p", { class: "small muted", style: "margin:0" }, `Your account (${state.me?.email || "you"}) and the time are recorded by the server when you sign. Editing the signature later re-stamps it.`))
        : caption);
    redraw();
    return dialog(sign ? "Sign" : "Drawing", body, [
      { label: "Cancel", value: undefined },
      { label: sign ? "Sign" : "Save drawing", submit: true, value: () => true },
    ]).then(async (ok) => {
      if (!ok) return;
      const name = typed.value.trim();
      if (!strokes.length && !(sign && name)) { toast(sign ? "Draw or type a signature" : "Draw something first"); return; }
      const content = sign && name
        ? { typed: name, w: W, h: H }
        : { strokes, w: W, h: H, width, ...(sign ? {} : { color, text: caption.value.trim() }) };
      // Re-render with the server's copy: it carries the signer/time stamp.
      const b = existing ? (await patchBlock(existing, { content }), existing) : await insert(type, content);
      if (b) refreshBlock(b);
      toast(sign ? "Signed" : "Drawing saved");
    });
  }

  // ── Drag & drop reordering (pointer events: mouse, touch and pen) ────────
  let drag = null, suppressClick = false;
  const blocksEl = $("blocks");
  const indicator = h("div", { class: "drop-line", "aria-hidden": "true" });

  blocksEl.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest(".handle");
    if (!handle || e.button !== 0) return;
    const el = handle.closest(".blk");
    const b = state.blocks.find((x) => x.id === el.dataset.id);
    if (!b || String(b.id).startsWith("tmp-")) return;
    drag = { b, el, handle, startY: e.clientY, active: false, target: null, pointerId: e.pointerId };
    handle.setPointerCapture(e.pointerId);
  });
  blocksEl.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      if (Math.abs(e.clientY - drag.startY) < 6) return;
      drag.active = true;
      document.activeElement?.blur?.(); // save in-progress typing first
      drag.el.classList.add("dragging");
      document.body.classList.add("is-dragging");
      blocksEl.append(indicator);
    }
    e.preventDefault();
    const others = [...blocksEl.querySelectorAll(".blk")].filter((x) => x !== drag.el);
    let idx = others.length;
    for (let i = 0; i < others.length; i++) {
      const r = others[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { idx = i; break; }
    }
    drag.target = idx;
    const wrapTop = blocksEl.getBoundingClientRect().top;
    const ref = others[idx] || others[others.length - 1];
    const y = ref ? (others[idx] ? ref.getBoundingClientRect().top : ref.getBoundingClientRect().bottom) - wrapTop : 0;
    indicator.style.top = `${Math.round(y) - 1}px`;
    // Auto-scroll near the viewport edges.
    if (e.clientY < 80) scrollBy(0, -12); else if (e.clientY > innerHeight - 60) scrollBy(0, 12);
  });
  const endDrag = async (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    indicator.remove();
    document.body.classList.remove("is-dragging");
    d.el.classList.remove("dragging");
    if (!d.active || d.target == null || e.type === "pointercancel") return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    await moveBlockTo(d.b, d.target);
  };
  blocksEl.addEventListener("pointerup", endDrag);
  blocksEl.addEventListener("pointercancel", endDrag);
  // A drag shouldn't also open the block menu.
  blocksEl.addEventListener("click", (e) => { if (suppressClick && e.target.closest(".handle")) { e.stopPropagation(); e.preventDefault(); } }, true);

  async function moveBlockTo(b, targetIdx) {
    await normalizePositions();
    if (state.blocks.indexOf(b) === targetIdx) return; // dropped where it was
    const rest = state.blocks.filter((x) => x !== b);
    const lo = rest[targetIdx - 1]?.position ?? "";
    const hi = rest[targetIdx]?.position ?? null;
    const prevOrder = [...state.blocks];
    rest.splice(targetIdx, 0, b);
    state.blocks = rest; // optimistic
    renderBlocks();
    try { await patchBlock(b, { position: keyBetween(lo, hi) }); }
    catch { state.blocks = prevOrder; renderBlocks(); }
  }

  window.KinynxEditor = { openInkPad, openCatalog, setTier };
  buildToolbar();
})();
