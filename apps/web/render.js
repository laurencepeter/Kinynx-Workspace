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

  // Read-only DOM rendering of one block.
  function renderBlock(b) {
    const c = b.content || {};
    let el;
    switch (b.type) {
      case "heading":
        el = document.createElement(`h${level(b)}`);
        el.textContent = textOf(b);
        break;
      case "checklist": {
        el = document.createElement("label");
        el.className = "k-check" + (c.checked ? " done" : "");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = !!c.checked;
        box.disabled = true;
        const span = document.createElement("span");
        span.textContent = textOf(b);
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
        el.textContent = textOf(b);
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
        el.textContent = textOf(b);
    }
    return el;
  }

  function renderReadOnly(blocks, container) {
    container.replaceChildren(...blocks.map(renderBlock));
  }

  function toMarkdown(page, blocks) {
    const out = [`# ${page.title || "Untitled"}`, ""];
    for (const b of blocks) {
      const t = textOf(b);
      const c = b.content || {};
      switch (b.type) {
        case "heading": out.push(`${"#".repeat(level(b) + 1)} ${t}`); break;
        case "checklist": out.push(`- [${c.checked ? "x" : " "}] ${t}`); break;
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
      } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        blocks.push({ type: "divider", content: {} });
      } else if (line.startsWith(">")) {
        const q = [line.replace(/^>\s?/, "")];
        while (i + 1 < lines.length && lines[i + 1].startsWith(">")) q.push(lines[++i].replace(/^>\s?/, ""));
        blocks.push({ type: "quote", content: { text: q.join("\n") } });
      } else {
        blocks.push({ type: "paragraph", content: { text: line.replace(/^\s*[-*]\s+/, "• ") } });
      }
    }
    return { title: title || "Imported page", blocks };
  }

  // Standalone, printable HTML document (Save as PDF from the print dialog).
  function toHtmlDocument(page, blocks) {
    const body = blocks
      .map((b) => {
        const t = esc(textOf(b));
        const c = b.content || {};
        switch (b.type) {
          case "heading": return `<h${level(b) + 1}>${t}</h${level(b) + 1}>`;
          case "checklist": return `<p class="check">${c.checked ? "☑" : "☐"} <span${c.checked ? ' class="done"' : ""}>${t}</span></p>`;
          case "code": return `<pre>${t}</pre>`;
          case "quote": return `<blockquote>${t}</blockquote>`;
          case "divider": return "<hr>";
          case "image": { const u = safeUrl(c.url); return u ? `<figure><img src="${esc(u)}" alt="${t}"><figcaption>${t}</figcaption></figure>` : ""; }
          case "embed": case "file": { const u = safeUrl(c.url); return u ? `<p><a href="${esc(u)}">${t || esc(u)}</a></p>` : `<p>${t}</p>`; }
          default: return `<p>${t}</p>`;
        }
      })
      .join("\n");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(page.title)}</title><style>
body{font:16px/1.65 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#1d1f27}
h1,h2,h3,h4{line-height:1.25}hr{border:0;border-top:1px solid #d6d9e3;margin:24px 0}
pre{background:#f4f5f8;padding:12px 14px;border-radius:8px;overflow:auto}
blockquote{border-left:3px solid #6d5efc;margin:0;padding:4px 14px;color:#555}
.done{text-decoration:line-through;color:#888}img{max-width:100%;border-radius:8px}
</style></head><body><h1>${esc(page.title)}</h1>
${body}
</body></html>`;
  }

  window.KinynxRender = { esc, safeUrl, colorFor, textOf, renderBlock, renderReadOnly, toMarkdown, fromMarkdown, toHtmlDocument };
})();
