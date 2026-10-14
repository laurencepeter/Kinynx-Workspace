// Kinynx rich-text engine: one small Tiptap (ProseMirror) editor per text
// block. Bundled to apps/web/vendor/kinynx-tiptap.js and exposed as
// window.KinynxTiptap — the static client has no build step of its own.
//
// SECURITY: ProseMirror only keeps what the schema below allows (it parses
// HTML into nodes/marks and re-serialises), so stored/pasted markup can't
// smuggle in elements or handlers. Colour attributes that Tiptap would echo
// into a style attribute are additionally validated, links are http(s)/mailto
// only, and the client re-sanitises everything it stores and renders
// (render.js cleanRich), so this is defence in depth, not the only gate.
import { Editor, Extension } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import HardBreak from "@tiptap/extension-hard-break";
import Bold from "@tiptap/extension-bold";
import Italic from "@tiptap/extension-italic";
import Underline from "@tiptap/extension-underline";
import Strike from "@tiptap/extension-strike";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import Highlight from "@tiptap/extension-highlight";
import Link from "@tiptap/extension-link";
import { TextStyle, Color, BackgroundColor, FontFamily, FontSize } from "@tiptap/extension-text-style";
import { UndoRedo, Placeholder } from "@tiptap/extensions";

const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+\s*)?\))$/i;
const safeColor = (v) => (typeof v === "string" && COLOR_RE.test(v.trim()) ? v.trim() : null);

// A block is a single paragraph; Shift+Enter inserts a line break inside it.
const BlockDocument = Document.extend({ content: "paragraph" });

// Highlight reads `data-color` verbatim and writes it into a style attribute;
// only accept real colours.
const SafeHighlight = Highlight.extend({
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el) => safeColor(el.getAttribute("data-color") || el.style.backgroundColor),
        renderHTML: (attrs) => {
          const c = safeColor(attrs.color);
          return c ? { "data-color": c, style: `background-color: ${c}; color: inherit` } : {};
        },
      },
    };
  },
});

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
function allowedHref(url) {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(url, "https://x.invalid").protocol) && /^(https?:|mailto:)/i.test(url);
  } catch {
    return false;
  }
}

/**
 * Mount an editor for one block.
 * @param {object} o
 * @param {HTMLElement} o.element   host element (the editor DOM goes inside)
 * @param {string} [o.html]         sanitised rich HTML, or
 * @param {string} [o.text]         plain text (newlines → line breaks)
 * @param {string} [o.placeholder]
 * @param {string} [o.className]    class for the contenteditable element
 * @param {Function} [o.onEnter]            Enter pressed (split into a new block)
 * @param {Function} [o.onBackspaceEmpty]   Backspace in an empty block
 * @param {Function} [o.onMove]             Alt+Shift+↑/↓ → onMove(-1|1)
 * @param {Function} [o.onFocus] @param {Function} [o.onBlur]
 * @param {Function} [o.onUpdate] @param {Function} [o.onSelection]
 */
export function createInlineEditor(o) {
  const call = (fn, ...a) => (typeof fn === "function" ? fn(...a) : undefined);
  const BlockKeys = Extension.create({
    name: "kinynxBlockKeys",
    addKeyboardShortcuts() {
      return {
        Enter: () => { call(o.onEnter); return true; },
        Backspace: ({ editor }) => {
          if (!editor.isEmpty) return false;
          call(o.onBackspaceEmpty);
          return true;
        },
        "Alt-Shift-ArrowUp": () => { call(o.onMove, -1); return true; },
        "Alt-Shift-ArrowDown": () => { call(o.onMove, 1); return true; },
      };
    },
  });

  const content = typeof o.html === "string" && o.html
    ? o.html
    : {
        type: "doc",
        content: [{
          type: "paragraph",
          content: String(o.text ?? "").split("\n").flatMap((line, i) => [
            ...(i ? [{ type: "hardBreak" }] : []),
            ...(line ? [{ type: "text", text: line }] : []),
          ]),
        }],
      };

  const editor = new Editor({
    element: o.element,
    content,
    extensions: [
      BlockDocument, Paragraph, Text, HardBreak, BlockKeys,
      Bold, Italic, Underline, Strike, Subscript, Superscript,
      SafeHighlight.configure({ multicolor: true }),
      TextStyle, Color, BackgroundColor, FontFamily, FontSize,
      Link.configure({
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
        protocols: ["http", "https", "mailto"],
        isAllowedUri: (url) => allowedHref(url),
        HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" },
      }),
      UndoRedo.configure({ depth: 200 }),
      Placeholder.configure({ placeholder: o.placeholder || "" }),
    ],
    editorProps: {
      attributes: { class: o.className || "ed", spellcheck: "true" },
    },
    onFocus: () => call(o.onFocus, editor),
    onBlur: () => call(o.onBlur, editor),
    onUpdate: () => call(o.onUpdate, editor),
    onSelectionUpdate: () => call(o.onSelection, editor),
  });
  return editor;
}

/** True when the editor content carries any formatting (marks). */
export function hasMarks(editor) {
  let found = false;
  editor.state.doc.descendants((node) => {
    if (found) return false;
    if (node.marks?.length) found = true;
    return !found;
  });
  return found;
}

export const version = "tiptap-3";
