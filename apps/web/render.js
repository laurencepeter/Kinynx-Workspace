// Shared, dependency-free block rendering used by the editor (app.js), the
// public viewer (p.html) and exports. SECURITY: user content is only ever set
// via textContent / escaped strings; URLs are restricted to http(s).
(function () {
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

  function safeUrl(u) {
    try {
      const url = new URL(String(u), location.origin);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch {
      return null;
    }
  }

  // Deterministic per-user colour (same person → same colour on every client).
  function colorFor(key) {
    let h = 0;
    for (const ch of String(key || "?")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `hsl(${h % 360} 70% 62%)`;
  }

  const textOf = (b) => (b.content && (b.content.text ?? b.content.code ?? b.content.title)) || "";
  const level = (b) => Math.min(3, Math.max(1, Number(b.content?.level) || 2));

  // ── Rich text ──────────────────────────────────────────────────────────────
  // Formatted text is stored as `content.rich` (HTML) next to `content.text`
  // (plain, used for search/Markdown). SECURITY: `rich` is untrusted — any API
  // client can write it — so it is never assigned to innerHTML. It is parsed in
  // an inert DOMParser document and *rebuilt* node-by-node from an allowlist of
  // tags, one http(s) attribute (a[href]) and regex-validated style values.
  const INLINE_TAGS = { B: "b", STRONG: "b", I: "i", EM: "i", U: "u", S: "s", STRIKE: "s", DEL: "s",
    MARK: "mark", SUB: "sub", SUP: "sup", SPAN: "span", FONT: "span", A: "a", CODE: "code" };
  const DROP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "TEXTAREA", "SELECT", "TITLE", "HEAD"]);
  const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+\s*)?\)|transparent)$/i;
  const SIZE_RE = /^(\d{1,3}(\.\d{1,2})?(px|pt|em|rem|%)|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large)$/;
  const FONTS = {
    sans: "ui-sans-serif, system-ui, sans-serif", serif: "Georgia, 'Times New Roman', serif",
    mono: "ui-monospace, Menlo, Consolas, monospace", hand: "'Segoe Script', 'Bradley Hand', 'Brush Script MT', cursive",
    rounded: "ui-rounded, 'SF Pro Rounded', system-ui, sans-serif",
  };
  const FONT_VALUES = new Set(Object.values(FONTS));
  const cleanFont = (v) => { const f = String(v).replace(/"/g, "'").trim(); return FONTS[f] || (FONT_VALUES.has(f) ? f : null); };
  const SPAN_STYLES = {
    color: (v) => COLOR_RE.test(v) && v, "background-color": (v) => COLOR_RE.test(v) && v,
    "font-size": (v) => SIZE_RE.test(v) && v, "font-family": cleanFont,
    "font-weight": (v) => /^(bold|normal|[1-9]00)$/.test(v) && v, "font-style": (v) => /^(italic|normal)$/.test(v) && v,
    "text-decoration-line": (v) => /^(none|underline|line-through|underline line-through)$/.test(v) && v,
    "text-decoration": (v) => /^(none|underline|line-through)$/.test(v) && v,
  };
  const FONT_SIZES = { 1: "x-small", 2: "small", 3: "medium", 4: "large", 5: "x-large", 6: "xx-large", 7: "xxx-large" };

  function cleanNode(node, out, depth) {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { out.append(child.data); continue; }
      if (child.nodeType !== 1 || depth > 20) continue;
      const tag = child.tagName;
      if (tag === "BR") { out.append(document.createElement("br")); continue; }
      if (tag === "DIV" || tag === "P") { // line breaks inside one block
        if (out.childNodes.length) out.append(document.createElement("br"));
        cleanNode(child, out, depth + 1);
        continue;
      }
      if (DROP.has(tag)) continue; // never keep script/style bodies, even as text
      const safe = INLINE_TAGS[tag];
      if (!safe) { cleanNode(child, out, depth + 1); continue; } // unwrap unknown
      const el = document.createElement(safe);
      if (safe === "a") {
        const href = safeUrl(child.getAttribute("href"));
        if (href) { el.href = href; el.target = "_blank"; el.rel = "noopener noreferrer"; }
      }
      if (safe === "span" || safe === "mark") {
        for (const [prop, check] of Object.entries(SPAN_STYLES)) {
          const v = child.style?.getPropertyValue(prop);
          const ok = v && check(v.trim());
          if (ok) el.style.setProperty(prop, ok);
        }
        if (tag === "FONT") { // legacy execCommand output
          const c = child.getAttribute("color"); if (c && COLOR_RE.test(c)) el.style.color = c;
          const z = FONT_SIZES[child.getAttribute("size")]; if (z) el.style.fontSize = z;
          const f = cleanFont(child.getAttribute("face") || ""); if (f) el.style.fontFamily = f;
        }
      }
      cleanNode(child, el, depth + 1);
      if (safe === "span" && !el.getAttribute("style")) out.append(...el.childNodes); // style-less span → unwrap
      else out.append(el);
    }
  }

  /** Untrusted HTML → safe DocumentFragment (allowlist rebuild, never innerHTML). */
  function richFragment(html) {
    const frag = document.createDocumentFragment();
    if (typeof html !== "string" || html.length > 200000) return frag;
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    cleanNode(doc.body, frag, 0);
    return frag;
  }
  /** Sanitised HTML string for storage (the output of richFragment). */
  function cleanRich(html) {
    const box = document.createElement("div");
    box.append(richFragment(html));
    return box.innerHTML;
  }
  /** Put a block's text into `el`, formatted when it has (sanitised) rich text. */
  function fillText(el, b) {
    const rich = b.content?.rich;
    if (typeof rich === "string" && rich) el.replaceChildren(richFragment(rich));
    else el.textContent = textOf(b);
  }

  // ── Block-level style (alignment, colours, borders, spacing) ──────────────
  // Every value is validated against a fixed vocabulary before it reaches CSSOM.
  const ALIGN = new Set(["left", "center", "right", "justify"]);
  const BORDER = new Set(["none", "solid", "dashed", "dotted", "double"]);
  const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
  function applyStyle(el, style) {
    const s = style && typeof style === "object" ? style : {};
    if (ALIGN.has(s.align)) el.style.textAlign = s.align;
    if (COLOR_RE.test(s.color || "")) el.style.color = s.color;
    if (COLOR_RE.test(s.bg || "")) el.style.backgroundColor = s.bg;
    if (SIZE_RE.test(s.size || "")) el.style.fontSize = s.size;
    const f = s.font && cleanFont(s.font); if (f) el.style.fontFamily = f;
    const lh = num(s.lineHeight, 1, 3); if (lh) el.style.lineHeight = String(lh);
    const ind = num(s.indent, 0, 8); if (ind) el.style.marginLeft = `${ind * 24}px`;
    if (BORDER.has(s.border) && s.border !== "none") {
      el.style.borderStyle = s.border;
      el.style.borderWidth = `${num(s.borderWidth, 1, 8) || 1}px`;
      el.style.borderColor = COLOR_RE.test(s.borderColor || "") ? s.borderColor : "currentColor";
    }
    const r = num(s.radius, 0, 24); if (r != null && s.radius !== undefined) el.style.borderRadius = `${r}px`;
    const pad = num(s.padding, 0, 40);
    if (pad) el.style.padding = `${pad}px`;
    else if (s.border && s.border !== "none" || s.bg) el.style.padding = "6px 10px";
    return el;
  }

  // ── Tables ────────────────────────────────────────────────────────────────
  const MAX_ROWS = 100, MAX_COLS = 20;
  function tableRows(c) {
    const rows = Array.isArray(c?.rows) ? c.rows.slice(0, MAX_ROWS) : [];
    const cols = Math.min(MAX_COLS, Math.max(1, ...rows.map((r) => (Array.isArray(r) ? r.length : 0))));
    return (rows.length ? rows : [[""]]).map((r) => Array.from({ length: cols }, (_, i) => String((Array.isArray(r) ? r[i] : "") ?? "")));
  }
  /** Render a table; `cell(td, text, r, c)` lets the editor make cells editable. */
  function renderTable(c, cell) {
    const rows = tableRows(c);
    const table = document.createElement("table");
    table.className = "k-table" + (c.striped ? " striped" : "");
    const border = BORDER.has(c.border) ? c.border : "solid";
    const bc = COLOR_RE.test(c.borderColor || "") ? c.borderColor : null;
    const hb = COLOR_RE.test(c.headerBg || "") ? c.headerBg : null;
    rows.forEach((r, ri) => {
      const tr = table.insertRow();
      r.forEach((text, ci) => {
        const td = document.createElement(c.header && ri === 0 ? "th" : "td");
        td.style.borderStyle = border === "none" ? "hidden" : border;
        if (bc) td.style.borderColor = bc;
        if (hb && c.header && ri === 0) td.style.backgroundColor = hb;
        const al = Array.isArray(c.align) ? c.align[ci] : null;
        if (ALIGN.has(al)) td.style.textAlign = al;
        if (cell) cell(td, text, ri, ci); else td.textContent = text;
        tr.append(td);
      });
    });
    const wrap = document.createElement("div");
    wrap.className = "k-table-wrap";
    wrap.append(table);
    return wrap;
  }

  // ── Signatures & drawings: vector strokes rendered as SVG ─────────────────
  // content.strokes = [[x0,y0,x1,y1,…], …] in a 0..W × 0..H box; numbers only.
  const SVG = "http://www.w3.org/2000/svg";
  function renderInk(c) {
    const W = num(c.w, 50, 2000) || 600, H = num(c.h, 30, 1200) || 200;
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("class", "k-ink");
    svg.setAttribute("role", "img");
    const color = COLOR_RE.test(c.color || "") ? c.color : "currentColor";
    let budget = 20000;
    for (const st of Array.isArray(c.strokes) ? c.strokes.slice(0, 500) : []) {
      if (!Array.isArray(st) || st.length < 2) continue;
      const pts = [];
      for (let i = 0; i + 1 < st.length && budget-- > 0; i += 2) {
        const x = num(st[i], 0, W), y = num(st[i + 1], 0, H);
        if (x != null && y != null) pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      }
      if (pts.length === 1) pts.push(pts[0]);
      const pl = document.createElementNS(SVG, "polyline");
      pl.setAttribute("points", pts.join(" "));
      pl.setAttribute("fill", "none");
      pl.setAttribute("stroke", color);
      pl.setAttribute("stroke-width", String(num(c.width, 1, 12) || 2.5));
      pl.setAttribute("stroke-linecap", "round");
      pl.setAttribute("stroke-linejoin", "round");
      svg.append(pl);
    }
    return svg;
  }
  function renderSignature(b) {
    const c = b.content || {};
    const fig = document.createElement("figure");
    fig.className = "k-sign";
    if (typeof c.typed === "string" && c.typed.trim()) {
      const t = document.createElement("div");
      t.className = "k-sign-typed";
      t.textContent = c.typed.slice(0, 120);
      fig.append(t);
    } else fig.append(renderInk(c));
    if (b.type === "signature") {
      const cap = document.createElement("figcaption");
      const when = c.signed_at && !isNaN(Date.parse(c.signed_at)) ? new Date(c.signed_at).toLocaleString() : "";
      cap.textContent = `Signed${c.signed_by ? ` by ${c.signed_by}` : ""}${when ? ` · ${when}` : ""}`;
      fig.append(cap);
    } else if (c.text) {
      const cap = document.createElement("figcaption");
      cap.textContent = c.text;
      fig.append(cap);
    }
    return fig;
  }

  /** 1-based number for each numbered_list block (consecutive runs restart). */
  function listNumbers(blocks) {
    const out = new Map();
    let n = 0;
    for (const b of blocks) { n = b.type === "numbered_list" ? n + 1 : 0; if (n) out.set(b, n); }
    return out;
  }

  // Styles for the newer block types, shared by the viewer and exports.
  const SHARED_CSS = `.k-li{display:flex;gap:8px}.k-mark{min-width:1.2em;text-align:right;opacity:.75;flex:none}
.k-callout{display:flex;gap:10px;padding:10px 14px;border-radius:10px;background:rgba(109,94,252,.12);border:1px solid rgba(109,94,252,.3)}
.k-table-wrap{overflow-x:auto;margin:6px 0}.k-table{border-collapse:collapse;min-width:50%}
.k-table td,.k-table th{border:1px solid #9aa0b4;padding:6px 10px;vertical-align:top;min-width:60px;height:2.4em;text-align:left}
.k-table th{background:rgba(127,127,127,.14);font-weight:650}.k-table.striped tr:nth-child(even) td{background:rgba(127,127,127,.08)}
.k-sign{margin:6px 0}.k-sign svg{width:100%;max-width:420px;height:auto;display:block}
.k-sign figcaption{font-size:12px;opacity:.7;border-top:1px solid rgba(127,127,127,.5);max-width:420px;padding-top:4px}
.k-sign-typed{font:32px/1.3 'Segoe Script','Bradley Hand','Brush Script MT',cursive;padding:4px 0}
mark{background:#fde68a;color:inherit;padding:0 2px;border-radius:3px}`;

  // Read-only DOM rendering of one block.
  function renderBlock(b, n) {
    const c = b.content || {};
    let el;
    switch (b.type) {
      case "heading":
        el = document.createElement(`h${level(b)}`);
        fillText(el, b);
        break;
      case "bulleted_list":
      case "numbered_list": {
        el = document.createElement("div");
        el.className = "k-li";
        const mark = document.createElement("span");
        mark.className = "k-mark";
        mark.textContent = b.type === "numbered_list" ? `${n || 1}.` : "•";
        const span = document.createElement("span");
        fillText(span, b);
        el.append(mark, span);
        break;
      }
      case "callout": {
        el = document.createElement("div");
        el.className = "k-callout";
        const icon = document.createElement("span");
        icon.textContent = typeof c.icon === "string" ? c.icon.slice(0, 8) : "💡";
        const span = document.createElement("div");
        fillText(span, b);
        el.append(icon, span);
        break;
      }
      case "table":
        el = renderTable(c);
        break;
      case "signature":
      case "drawing":
        el = renderSignature(b);
        break;
      case "checklist": {
        el = document.createElement("label");
        el.className = "k-check" + (c.checked ? " done" : "");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = !!c.checked;
        box.disabled = true;
        const span = document.createElement("span");
        fillText(span, b);
        el.append(box, span);
        break;
      }
      case "code":
        el = document.createElement("pre");
        el.className = "k-code";
        el.textContent = textOf(b);
        break;
      case "quote":
        el = document.createElement("blockquote");
        fillText(el, b);
        break;
      case "divider":
        el = document.createElement("hr");
        break;
      case "image": {
        const src = safeUrl(c.url);
        el = document.createElement("figure");
        if (src) {
          const img = document.createElement("img");
          img.src = src;
          img.alt = c.text || "";
          img.loading = "lazy";
          img.referrerPolicy = "no-referrer";
          el.append(img);
        }
        if (c.text) {
          const cap = document.createElement("figcaption");
          cap.textContent = c.text;
          el.append(cap);
        }
        break;
      }
      case "embed":
      case "file": {
        el = document.createElement("p");
        const href = safeUrl(c.url);
        if (href) {
          const a = document.createElement("a");
          a.href = href;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = c.text || href;
          el.append(a);
        } else el.textContent = c.text || "";
        break;
      }
      default:
        el = document.createElement("p");
        fillText(el, b);
    }
    return applyStyle(el, c.style);
  }

  function renderReadOnly(blocks, container) {
    const nums = listNumbers(blocks);
    container.replaceChildren(...blocks.map((b) => renderBlock(b, nums.get(b))));
  }

  function toMarkdown(page, blocks) {
    const out = [`# ${page.title || "Untitled"}`, ""];
    const nums = listNumbers(blocks);
    for (const b of blocks) {
      const t = textOf(b);
      const c = b.content || {};
      switch (b.type) {
        case "heading": out.push(`${"#".repeat(level(b) + 1)} ${t}`); break;
        case "checklist": out.push(`- [${c.checked ? "x" : " "}] ${t}`); break;
        case "bulleted_list": out.push(`- ${t}`); break;
        case "numbered_list": out.push(`${nums.get(b)}. ${t}`); break;
        case "callout": out.push(`> ${c.icon || "💡"} ${t}`); break;
        case "table": {
          const rows = tableRows(c);
          const cell = (x) => x.replace(/\|/g, "\\|").replace(/\n/g, " ");
          rows.forEach((r, i) => {
            out.push(`| ${r.map(cell).join(" | ")} |`);
            if (i === 0) out.push(`|${r.map(() => " --- ").join("|")}|`);
          });
          break;
        }
        case "signature": out.push(`*Signed${c.signed_by ? ` by ${c.signed_by}` : ""}${c.signed_at ? ` on ${c.signed_at}` : ""}*`); break;
        case "drawing": out.push(`*[drawing]*`); break;
        case "code": out.push("```" + (c.language || ""), t, "```"); break;
        case "quote": out.push(...t.split("\n").map((l) => `> ${l}`)); break;
        case "divider": out.push("---"); break;
        case "image": out.push(`![${c.text || ""}](${safeUrl(c.url) || ""})`); break;
        case "embed": case "file": out.push(`[${c.text || c.url || ""}](${safeUrl(c.url) || ""})`); break;
        default: out.push(t);
      }
      out.push("");
    }
    return out.join("\n");
  }

  // Parse Markdown into portable blocks (headings, checklists, quotes, code,
  // dividers, paragraphs). Used for importing .md files.
  function fromMarkdown(md) {
    const lines = String(md).replace(/\r\n?/g, "\n").split("\n");
    let title = null;
    const blocks = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;
      if (!line.trim()) continue;
      if (line.startsWith("```")) {
        const language = line.slice(3).trim();
        const code = [];
        while (++i < lines.length && !lines[i].startsWith("```")) code.push(lines[i]);
        blocks.push({ type: "code", content: { text: code.join("\n"), language } });
      } else if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
        if (m[1].length === 1 && title === null && blocks.length === 0) title = m[2].trim();
        else blocks.push({ type: "heading", content: { text: m[2].trim(), level: Math.max(1, m[1].length - 1) } });
      } else if ((m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/))) {
        blocks.push({ type: "checklist", content: { text: m[2], checked: m[1] !== " " } });
      } else if (/^\s*\|.*\|\s*$/.test(line)) {
        const rows = [];
        for (i--; i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1]); ) {
          const row = lines[++i].trim().slice(1, -1).split(/(?<!\\)\|/).map((x) => x.trim().replace(/\\\|/g, "|"));
          if (!row.every((x) => /^:?-{3,}:?$/.test(x))) rows.push(row);
        }
        blocks.push({ type: "table", content: { rows, header: true } });
      } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        blocks.push({ type: "numbered_list", content: { text: m[1] } });
      } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/)) && !/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
        blocks.push({ type: "bulleted_list", content: { text: m[1] } });
      } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        blocks.push({ type: "divider", content: {} });
      } else if (line.startsWith(">")) {
        const q = [line.replace(/^>\s?/, "")];
        while (i + 1 < lines.length && lines[i + 1].startsWith(">")) q.push(lines[++i].replace(/^>\s?/, ""));
        blocks.push({ type: "quote", content: { text: q.join("\n") } });
      } else {
        blocks.push({ type: "paragraph", content: { text: line } });
      }
    }
    return { title: title || "Imported page", blocks };
  }

  // Standalone, printable HTML document (Save as PDF from the print dialog).
  // Built from the same DOM renderer, so escaping and sanitising are shared.
  const DOC_CSS = `body{font:16px/1.65 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#1d1f27}
h1,h2,h3,h4{line-height:1.25}hr{border:0;border-top:1px solid #d6d9e3;margin:24px 0}p{margin:6px 0}
pre{background:#f4f5f8;padding:12px 14px;border-radius:8px;overflow:auto}
blockquote{border-left:3px solid #6d5efc;margin:0;padding:4px 14px;color:#555}
.k-check{display:flex;gap:8px}.k-check.done span{text-decoration:line-through;color:#888}img{max-width:100%;border-radius:8px}
${SHARED_CSS}`;
  function toHtmlDocument(page, blocks) {
    const body = document.createElement("div");
    renderReadOnly(blocks, body);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(page.title)}</title><style>${DOC_CSS}</style></head><body><h1>${esc(page.title)}</h1>
${body.innerHTML}
</body></html>`;
  }

  // Inject the shared block styles once into any page that loads this file.
  if (typeof document !== "undefined" && !document.getElementById("k-shared-css")) {
    const st = document.createElement("style");
    st.id = "k-shared-css";
    st.textContent = SHARED_CSS;
    document.head.append(st);
  }

  window.KinynxRender = {
    esc, safeUrl, colorFor, textOf, renderBlock, renderReadOnly, toMarkdown, fromMarkdown, toHtmlDocument,
    richFragment, cleanRich, fillText, applyStyle, renderTable, tableRows, renderSignature, listNumbers, FONTS,
    MAX_ROWS, MAX_COLS,
  };
})();
