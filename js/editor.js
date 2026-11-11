/* ============================================================
   editor.js — 轻量代码编辑器
   textarea 输入层 + 语法高亮层 + 行号槽，断点与当前执行行
   ============================================================ */

function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* 伪指令集合 */
const DIRECTIVES = new Set([
  "DB", "DW", "DD", "SEGMENT", "ENDS", "ASSUME", "ORG", "END", "EQU",
  "DUP", "PTR", "OFFSET", "SEG", "BYTE", "WORD", "DWORD", "NEAR", "FAR",
  "SHORT", "PROC", "ENDP", "PUBLIC", "EXTRN", "NOTHING", "MODEL"
]);

/* 标识符分类 */
function classifyIdent(word) {
  const up = word.toUpperCase();
  if (MNEMONICS.has(up) || JCC_ALIAS[up]) return "tok-mnemonic";
  if (REG16[up] !== undefined || REG8[up] !== undefined || SREG[up] !== undefined) return "tok-reg";
  if (DIRECTIVES.has(up)) return "tok-directive";
  if (REP_PREFIXES.has(up)) return "tok-prefix";
  if (up.startsWith(".")) return "tok-directive";
  return null;
}

/* 单行高亮 */
function highlightLine(text) {
  if (!text) return "";
  const lead = text.match(/^\s*([A-Za-z_$@?][A-Za-z0-9_$@?]*)\s*:/);
  let firstIdent = true;
  const re = /(;.*$)|('(?:[^'])*'|"(?:[^"])*")|([A-Za-z_$@?][A-Za-z0-9_$@?]*)|(0x[0-9A-Fa-f]+|[0-9][0-9A-Fa-f]*[Hh]|[01]+[Bb]|[0-7]+[OoQq]|[0-9]+)|(\s+)|(.)/g;

  return escHtml(text).replace(re, (match, comment, str, ident, num, ws, other, offset) => {
    if (comment) return `<span class="tok-comment">${comment}</span>`;
    if (str) return `<span class="tok-str">${str}</span>`;
    if (num) return `<span class="tok-num">${num}</span>`;
    if (ws) return ws;
    if (ident) {
      /* 行首标签 */
      if (firstIdent && lead && ident.toUpperCase() === lead[1].toUpperCase()) {
        firstIdent = false;
        return `<span class="tok-label">${ident}</span>`;
      }
      firstIdent = false;
      const cls = classifyIdent(ident);
      return cls ? `<span class="${cls}">${ident}</span>` : ident;
    }
    return other;
  });
}

class Editor {
  constructor(inputEl, hlEl, gutterEl) {
    this.input = inputEl;
    this.hl = hlEl;
    this.code = hlEl.querySelector("code");
    this.gutter = gutterEl;
    this.bpLines = new Set();
    this.currentLine = 0;
    this.bind();
    this.refresh();
  }

  getText() { return this.input.value; }
  setText(s) {
    this.input.value = s;
    this.refresh();
  }

  bind() {
    this.input.addEventListener("input", () => this.refresh());
    this.input.addEventListener("scroll", () => this.syncScroll());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const s = this.input.selectionStart;
        this.input.value = this.input.value.slice(0, s) + "    " +
          this.input.value.slice(this.input.selectionEnd);
        this.input.selectionStart = this.input.selectionEnd = s + 4;
        this.refresh();
      }
    });
    /* 断点：事件委托 */
    this.gutter.addEventListener("click", (e) => {
      const line = e.target.closest(".gutter-line");
      if (!line) return;
      const n = parseInt(line.dataset.line, 10);
      if (this.bpLines.has(n)) this.bpLines.delete(n);
      else this.bpLines.add(n);
      this.refresh();
      if (this.onBreakpoint) this.onBreakpoint();
    });
  }

  syncScroll() {
    this.hl.scrollTop = this.input.scrollTop;
    this.hl.scrollLeft = this.input.scrollLeft;
    this.gutter.scrollTop = this.input.scrollTop;
  }

  setCurrentLine(line) {
    this.currentLine = line || 0;
    this.refresh();
  }

  clearBreakpoints() {
    this.bpLines.clear();
    this.refresh();
  }

  refresh() {
    const lines = this.input.value.split("\n");
    /* 高亮（含当前执行行标记） */
    this.code.innerHTML = lines.map((ln, i) => {
      const hl = highlightLine(ln);
      return (i + 1 === this.currentLine)
        ? `<span class="exec-line">${hl || " "}</span>`
        : hl;
    }).join("\n");

    /* 行号 */
    this.gutter.innerHTML = lines.map((ln, i) => {
      const n = i + 1;
      const cls = ["gutter-line"];
      if (this.bpLines.has(n)) cls.push("bp");
      if (n === this.currentLine) cls.push("current");
      return `<div class="${cls.join(" ")}" data-line="${n}">${n}</div>`;
    }).join("");

    this.syncScroll();
  }
}
