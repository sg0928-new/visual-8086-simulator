/* ============================================================
   assembler.js — 两遍汇编器（MASM/TASM 风格语法子集）
   支持：完整段 SEGMENT/ENDS、简化段 .DATA/.CODE/.STACK、
   DB/DW/DD/DUP/EQU/=/ORG/ASSUME/END、OFFSET/SEG/PTR/$、
   标签前向引用、表达式、全部 8086 寻址方式
   ============================================================ */

/* 支持的指令助记符 */
const MNEMONICS = new Set([
  "MOV","PUSH","POP","XCHG","LEA","LDS","LES","XLAT","LAHF","SAHF","PUSHF","POPF",
  "ADD","ADC","INC","SUB","SBB","DEC","NEG","CMP","MUL","IMUL","DIV","IDIV","CBW","CWD","DAA","DAS","AAA","AAS","AAM","AAD",
  "AND","OR","XOR","NOT","TEST","SHL","SAL","SHR","SAR","ROL","ROR","RCL","RCR",
  "MOVSB","MOVSW","CMPSB","CMPSW","SCASB","SCASW","LODSB","LODSW","STOSB","STOSW",
  "MOVS","CMPS","SCAS","LODS","STOS",
  "JMP","JZ","JNZ","JE","JNE","JC","JNC","JB","JNB","JAE","JBE","JA","JNA","JNAE","JNBE",
  "JG","JGE","JL","JLE","JNG","JNGE","JNL","JNLE",
  "JO","JNO","JS","JNS","JP","JNP","JPE","JPO","JCXZ",
  "LOOP","LOOPE","LOOPNE","LOOPZ","LOOPNZ",
  "CALL","RET","RETF","IRET","INT","INTO",
  "CLC","STC","CMC","CLD","STD","CLI","STI","NOP","HLT","IN","OUT"
]);

/* 条件跳转别名 -> 规范名 */
const JCC_ALIAS = {
  JE:"JZ", JNE:"JNZ", JNB:"JAE", JNAE:"JB", JNA:"JBE", JNBE:"JA",
  JNL:"JGE", JNGE:"JL", JNG:"JLE", JNLE:"JG", JPE:"JP", JPO:"JNP"
};

/* 串操作前缀 */
const REP_PREFIXES = new Set(["REP", "REPE", "REPNE", "REPZ", "REPNZ"]);

/* 无操作数指令（部分） */
const NO_OPERAND = new Set([
  "LAHF","SAHF","PUSHF","POPF","CBW","CWD","DAA","DAS","AAA","AAS","AAM","AAD",
  "MOVSB","MOVSW","CMPSB","CMPSW","SCASB","SCASW","LODSB","LODSW","STOSB","STOSW",
  "CLC","STC","CMC","CLD","STD","CLI","STI","NOP","HLT","IRET","INTO","RET","RETF"
]);

/* ---------------- 词法工具 ---------------- */

function isIdentChar(c) { return /[A-Za-z0-9_$@?]/.test(c); }
function isIdentStart(c) { return /[A-Za-z_$@?]/.test(c); }

/* 剥离注释（字符串感知） */
function stripComment(line) {
  let inStr = false, q = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) { if (c === q) inStr = false; }
    else {
      if (c === "'" || c === '"') { inStr = true; q = c; }
      else if (c === ";") return line.slice(0, i);
    }
  }
  return line;
}

/* 按顶层逗号拆分（忽略括号与引号） */
function splitTopComma(s) {
  const parts = [];
  let depth = 0, inStr = false, q = "", cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { cur += c; if (c === q) inStr = false; continue; }
    if (c === "'" || c === '"') { inStr = true; q = c; cur += c; continue; }
    if (c === "(" || c === "[") { depth++; cur += c; continue; }
    if (c === ")" || c === "]") { depth--; cur += c; continue; }
    if (c === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim() !== "") parts.push(cur);
  return parts;
}

/* 解析数字/字符常量，返回 {value} 或 null */
function parseNumber(tok) {
  tok = tok.trim();
  if (/^0X[0-9A-F]+$/i.test(tok)) return { value: parseInt(tok.slice(2), 16) };
  if (/^[0-9][0-9A-F]*H$/i.test(tok)) return { value: parseInt(tok.slice(0, -1), 16) };
  if (/^[01]+B$/i.test(tok)) return { value: parseInt(tok.slice(0, -1), 2) };
  if (/^[0-7]+[OQ]$/i.test(tok)) return { value: parseInt(tok.slice(0, -1), 8) };
  if (/^[0-9]+D?$/i.test(tok)) return { value: parseInt(tok.replace(/D$/i, ""), 10) };
  if (/^'.'$/.test(tok) || /^"."$/.test(tok)) return { value: tok.charCodeAt(1) };
  return null;
}

/* 提取字符串字面量（首尾引号） */
function parseString(tok) {
  tok = tok.trim();
  if ((tok.startsWith("'") && tok.endsWith("'") && tok.length >= 2) ||
      (tok.startsWith('"') && tok.endsWith('"') && tok.length >= 2)) {
    return tok.slice(1, -1).split("").map(c => c.charCodeAt(0));
  }
  return null;
}

/* ---------------- 表达式求值（递归下降） ---------------- */
class ExprParser {
  constructor(tokens, asm, line) {
    this.tk = tokens; this.p = 0; this.asm = asm; this.line = line;
  }
  peek() { return this.tk[this.p]; }
  next() { return this.tk[this.p++]; }
  parse() {
    const v = this.parseOr();
    if (this.p < this.tk.length) throw new Error("表达式存在多余符号: " + this.peek());
    return v;
  }
  parseOr() {
    let v = this.parseAnd();
    while (this.peek() && /^(OR|\|)$/i.test(this.peek())) {
      this.next(); v = v | this.parseAnd();
    }
    return v & MASK16;
  }
  parseAnd() {
    let v = this.parseAdd();
    while (this.peek() && /^(AND|&)$/i.test(this.peek())) {
      this.next(); v = v & this.parseAdd();
    }
    return v;
  }
  parseAdd() {
    let v = this.parseMul();
    while (this.peek() && /^(\+|-)$/.test(this.peek())) {
      const op = this.next();
      const r = this.parseMul();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  parseMul() {
    let v = this.parseUnary();
    while (this.peek() && /^(\*|\/|MOD|%|\^|XOR)$/i.test(this.peek())) {
      const op = this.next().toUpperCase();
      const r = this.parseUnary();
      if (op === "*") v = v * r;
      else if (op === "/" || op === "%") v = r === 0 ? 0 : Math.floor(v / r);
      else if (op === "MOD") v = r === 0 ? 0 : v % r;
      else if (op === "XOR" || op === "^") v = v ^ r;
    }
    return v;
  }
  parseUnary() {
    if (this.peek() === "-" || this.peek() === "+") {
      const op = this.next();
      const v = this.parseUnary();
      return op === "-" ? -v : v;
    }
    return this.parseAtom();
  }
  parseAtom() {
    const t = this.next();
    if (t === "(") {
      const v = this.parseOr();
      if (this.next() !== ")") throw new Error("缺少右括号 )");
      return v;
    }
    const num = parseNumber(t);
    if (num) return num.value;
    if (t === "$") return this.asm.curSeg.loc;
    /* 简化段预定义符号 @DATA */
    if (t.toUpperCase() === "@DATA") {
      const ds = this.asm.segments.get("_DATA");
      return ds ? ds.baseSeg : 0;
    }
    /* 段名：MOV AX, DATA -> 段地址 */
    if (this.asm.segments.has(t.toUpperCase())) {
      return this.asm.segments.get(t.toUpperCase()).baseSeg;
    }
    /* 符号 */
    const sym = this.asm.symbols.get(t.toUpperCase());
    if (sym) {
      if (sym.type === "equ") return sym.value;
      if (sym.type === "var" || sym.type === "label") return sym.off;
    }
    throw new Error("未定义的符号: " + t);
  }
}

/* 表达式词法切分 */
function tokenizeExpr(s) {
  const tk = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "(" || c === ")" || c === "+" || c === "-" || c === "*" ||
        c === "/" || c === "|" || c === "&" || c === "^" || c === "%") {
      tk.push(c); i++; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j++;
      tk.push(s.slice(i, j + 1)); i = j + 1; continue;
    }
    let j = i;
    while (j < s.length && isIdentChar(s[j])) j++;
    tk.push(s.slice(i, j)); i = j;
  }
  return tk;
}

/* ============================================================
   汇编器主类
   ============================================================ */
class Assembler {
  constructor() {
    this.errors = [];
  }

  err(line, msg) {
    this.errors.push({ line, msg });
  }

  assemble(source) {
    this.errors = [];
    this.segments = new Map();
    this.segOrder = [];
    this.curSeg = null;
    this.symbols = new Map();
    this.program = [];
    this.codeMap = new Map();
    this.assume = {};
    this.entry = null;
    this.rawLines = source.replace(/\r\n/g, "\n").split("\n");
    this.autoSegCounter = 0;

    /* 预处理：简化段归一 + 行结构化 */
    this.prepared = [];
    for (let i = 0; i < this.rawLines.length; i++) {
      const raw = stripComment(this.rawLines[i]).trim();
      this.prepared.push({ line: i + 1, text: raw });
    }

    this.preScanSymbols();       // 第 0 遍：确定全部符号类型（含前向引用）
    this.pass1();
    this.allocateSegments();
    this.pass2();
    return this.buildResult();
  }

  /* 第 0 遍：纯符号类型扫描，保证两遍长度计算使用相同解析逻辑 */
  preScanSymbols() {
    const declared = new Map();
    for (const rec of this.prepared) {
      const { line, text } = rec;
      if (!text) continue;
      let body = text;
      const lblM = body.match(/^([A-Za-z_$@?][A-Za-z0-9_$@?]*)\s*:([\s\S]*)$/);
      if (lblM) {
        const nm = lblM[1].toUpperCase();
        if (declared.has(nm) && declared.get(nm) !== line) this.err(line, "符号重复定义: " + nm);
        declared.set(nm, line);
        if (!this.symbols.has(nm)) this.symbols.set(nm, { type: "label", seg: null, off: 0, line });
        body = lblM[2].trim();
        if (!body) continue;
      }
      const nameM = body.match(/^([A-Za-z_$@?][A-Za-z0-9_$@?]*)\s+([\s\S]+)$/);
      if (nameM) {
        const nm = nameM[1].toUpperCase();
        const kw = this.firstToken(nameM[2]).word.toUpperCase();
        if (kw === "DB" || kw === "DW" || kw === "DD") {
          if (declared.has(nm) && declared.get(nm) !== line) this.err(line, "符号重复定义: " + nm);
          declared.set(nm, line);
          if (!this.symbols.has(nm))
            this.symbols.set(nm, { type: "var", seg: null, off: 0, size: kw === "DB" ? 8 : 16, line, kind: kw });
        } else if (kw === "EQU" || kw === "=") {
          if (declared.has(nm) && declared.get(nm) !== line) this.err(line, "符号重复定义: " + nm);
          declared.set(nm, line);
          if (!this.symbols.has(nm)) this.symbols.set(nm, { type: "equ", value: 0, line });
        } else if (kw === "PROC") {
          if (!this.symbols.has(nm)) this.symbols.set(nm, { type: "label", seg: null, off: 0, line });
        }
      }
    }
  }

  /* ---------------- 段管理 ---------------- */
  beginSegment(name, line) {
    if (!this.segments.has(name)) {
      const seg = { name, loc: 0, size: 0, data: [], isCode: false, baseSeg: 0 };
      this.segments.set(name, seg);
      this.segOrder.push(seg);
    }
    this.curSeg = this.segments.get(name);
  }
  endSegment(name, line) {
    if (!this.curSeg || this.curSeg.name !== name) {
      this.err(line, "ENDS 与当前段不匹配: " + name);
      return;
    }
    this.curSeg.size = Math.max(this.curSeg.size, this.curSeg.loc);
    this.curSeg = null;
  }

  /* ---------------- 第一遍：符号与位置 ---------------- */
  pass1() {
    for (const rec of this.prepared) {
      const { line, text } = rec;
      if (!text) continue;
      let body = text;

      /* 行首标签 */
      const lblM = body.match(/^([A-Za-z_$@?][A-Za-z0-9_$@?]*)\s*:([\s\S]*)$/);
      if (lblM) {
        this.defineLabel(lblM[1].toUpperCase(), line);
        body = lblM[2].trim();
        if (!body) continue;
      }

      /* 首 token 切分 */
      const first = this.firstToken(body);
      const up = first.word.toUpperCase();

      /* 简化段伪指令 */
      if (up === ".DATA" || up === ".DATA?" || up === ".CONST") {
        this.beginSegment("_DATA", line);
        this.curSeg.isCode = false;
        continue;
      }
      if (up === ".CODE") {
        const rest = body.slice(first.len).trim();
        this.beginSegment(rest ? rest.toUpperCase() : "_CODE", line);
        this.curSeg.isCode = true;
        continue;
      }
      if (up === ".STACK") {
        const rest = body.slice(first.len).trim();
        const sz = rest ? parseInt(rest, 10) || 1024 : 1024;
        this.beginSegment("_STACK", line);
        this.curSeg.size = sz;
        this.curSeg.loc = sz;
        this.curSeg.isStack = true;
        continue;
      }
      if (up === ".MODEL") continue;

      if (up === "ASSUME") { continue; }
      if (up === "END") {
        const rest = body.slice(first.len).trim();
        if (rest) this.entry = rest.toUpperCase();
        continue;
      }
      if (up === "ORG") {
        if (!this.curSeg) { this.err(line, "ORG 必须位于段内"); continue; }
        const rest = body.slice(first.len).trim();
        try {
          this.curSeg.loc = this.evalExpr(rest, line) & MASK16;
        } catch (e) { this.err(line, e.message); }
        continue;
      }

      /* 名称型定义：NAME DB ... / NAME EQU ... / NAME = ... */
      const nameM = body.match(/^([A-Za-z_$@?][A-Za-z0-9_$@?]*)\s+([\s\S]+)$/);
      if (nameM) {
        const nm = nameM[1].toUpperCase();
        const rest0 = nameM[2];
        const kw = this.firstToken(rest0).word.toUpperCase();

        if (kw === "SEGMENT") { this.beginSegment(nm, line); continue; }
        if (kw === "ENDS") { this.endSegment(nm, line); continue; }

        if (kw === "EQU") {
          const expr = rest0.slice(this.firstToken(rest0).len).trim();
          try {
            const val = this.evalExpr(expr, line);
            this.symbols.set(nm, { type: "equ", value: val & MASK16, line });
          } catch (e) { this.err(line, "EQU 表达式错误: " + e.message); }
          continue;
        }
        if (kw === "=") {
          const expr = rest0.slice(this.firstToken(rest0).len).trim();
          try {
            this.symbols.set(nm, { type: "equ", value: this.evalExpr(expr, line) & MASK16, line });
          } catch (e) { this.err(line, e.message); }
          continue;
        }
        if (kw === "DB" || kw === "DW" || kw === "DD") {
          if (!this.curSeg) { this.err(line, "数据定义必须位于段内"); continue; }
          const exVar = this.symbols.get(nm) || {};
          this.symbols.set(nm, Object.assign({}, exVar, {
            type: "var", seg: this.curSeg.name, off: this.curSeg.loc,
            size: exVar.size || (kw === "DB" ? 8 : 16), kind: kw
          }));
          const items = rest0.slice(this.firstToken(rest0).len);
          const len = this.dataByteLength(items, kw, line);
          this.curSeg.loc = (this.curSeg.loc + len) & MASK16;
          continue;
        }
        /* PROC 声明 */
        if (kw === "PROC") {
          this.defineLabel(nm, line);
          continue;
        }
        if (kw === "ENDP") continue;
      }

      /* 无标签数据定义 */
      if (up === "DB" || up === "DW" || up === "DD") {
        if (!this.curSeg) { this.err(line, "数据定义必须位于段内"); continue; }
        const items = body.slice(first.len);
        this.curSeg.loc = (this.curSeg.loc + this.dataByteLength(items, up, line)) & MASK16;
        continue;
      }

      /* REP 前缀行：前缀 + 串指令（无操作数） */
      if (REP_PREFIXES.has(up)) {
        if (!this.curSeg) { this.err(line, "指令必须位于代码段内"); continue; }
        this.curSeg.isCode = true;
        const stripped = this.stripRepPrefix(body);
        const realM = this.firstToken(stripped.realOps).word.toUpperCase();
        let sz;
        try { sz = this.irSize(JCC_ALIAS[realM] || realM, [], realM, stripped.realOps); }
        catch (e) { sz = this.estimateSize(realM, stripped.realOps, line); }
        this.curSeg.loc = (this.curSeg.loc + sz) & MASK16;
        continue;
      }

      /* 指令：与第二遍相同的精确长度计算 */
      if (MNEMONICS.has(up) || JCC_ALIAS[up]) {
        if (!this.curSeg) { this.err(line, "指令必须位于代码段内"); continue; }
        this.curSeg.isCode = true;
        const ops = body.slice(first.len).trim();
        let sz;
        try {
          const stripped = this.stripRepPrefix(ops);
          const tmpOps = stripped.realOps.trim()
            ? splitTopComma(stripped.realOps).map(p => this.parseOperand(p.trim(), line, up))
            : [];
          sz = this.irSize(JCC_ALIAS[up] || up, tmpOps, up, stripped.realOps);
        } catch (e) { sz = this.estimateSize(up, ops, line); }
        this.curSeg.loc = (this.curSeg.loc + sz) & MASK16;
        continue;
      }

      this.err(line, "无法识别的语句或助记符: " + up);
    }

    /* 段收尾 */
    for (const seg of this.segOrder) seg.size = Math.max(seg.size, seg.loc);
  }

  defineLabel(name, line) {
    if (!this.curSeg) { this.err(line, "标号必须位于段内: " + name); return; }
    const ex = this.symbols.get(name) || {};
    this.symbols.set(name, Object.assign({}, ex, {
      type: ex.type || "label", seg: this.curSeg.name, off: this.curSeg.loc, line
    }));
  }

  /* 剥离串操作前缀，返回 {rep, realOps} */
  stripRepPrefix(opsText) {
    const m = opsText.match(/^(REP|REPE|REPZ|REPNE|REPNZ)\s+([\s\S]+)$/i);
    if (!m) return { rep: null, realOps: opsText };
    const rep = m[1].toUpperCase().replace("REPZ", "REPE").replace("REPNZ", "REPNE");
    return { rep, realOps: m[2] };
  }

  /* ---------------- 数据长度/字节生成 ---------------- */
  dataByteLength(items, kind, line) {
    const unit = kind === "DB" ? 1 : kind === "DW" ? 2 : 4;
    let total = 0;
    for (const part of splitTopComma(items)) {
      const t = part.trim();
      if (!t) continue;
      const str = parseString(t);
      if (str) {
        if (kind === "DB") total += str.length;
        else if (kind === "DW") total += 2 * Math.max(1, str.length);
        else total += 4;
        continue;
      }
      /* DUP */
      const dupM = t.match(/^([\s\S]+?)\s+DUP\s*\(([\s\S]*)\)$/i);
      if (dupM) {
        let cnt;
        try { cnt = this.evalExpr(dupM[1].trim(), line); }
        catch (e) { this.err(line, e.message); cnt = 0; }
        const inner = this.dataByteLength(dupM[2], kind, line);
        total += cnt * inner;
        continue;
      }
      total += unit;
    }
    return total;
  }

  /* 生成数据字节（第二遍） */
  emitData(items, kind, line) {
    const out = [];
    const pushVal = (v) => {
      if (kind === "DB") out.push(v & 0xFF);
      else if (kind === "DW") { out.push(v & 0xFF, (v >> 8) & 0xFF); }
      else {
        out.push(v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF);
      }
    };
    for (const part of splitTopComma(items)) {
      const t = part.trim();
      if (!t) continue;
      const str = parseString(t);
      if (str) {
        if (kind === "DB") str.forEach(b => out.push(b));
        else if (kind === "DW") {
          for (let i = 0; i < str.length; i += 2) {
            out.push(str[i], str[i + 1] === undefined ? 0 : str[i + 1]);
          }
        } else pushVal(0);
        continue;
      }
      const dupM = t.match(/^([\s\S]+?)\s+DUP\s*\(([\s\S]*)\)$/i);
      if (dupM) {
        let cnt;
        try { cnt = this.evalExpr(dupM[1].trim(), line); }
        catch (e) { this.err(line, e.message); cnt = 0; }
        const inner = this.emitData(dupM[2], kind, line);
        for (let i = 0; i < cnt; i++) out.push(...inner);
        continue;
      }
      if (t === "?") { pushVal(0); continue; }
      try { pushVal(this.evalExpr(t, line) & MASK16); }
      catch (e) { this.err(line, e.message); pushVal(0); }
    }
    return out;
  }

  /* ---------------- 段地址分配 ---------------- */
  allocateSegments() {
    let next = 0x1000;
    for (const seg of this.segOrder) {
      seg.baseSeg = next;
      const paras = Math.max(1, Math.ceil(seg.size / 16));
      next += paras;
    }
    /* 无显式栈段则创建内部栈 */
    if (!this.segOrder.some(s => s.isStack)) {
      const st = { name: "_STACK", loc: 0, size: 1024, data: [], isCode: false, baseSeg: next, isStack: true };
      this.segOrder.push(st);
      this.segments.set("_STACK", st);
      next += Math.ceil(1024 / 16);
    }
  }

  /* ---------------- 第二遍：生成 IR ---------------- */
  pass2() {
    for (const seg of this.segOrder) { seg.loc = 0; }
    this.curSeg = null;

    for (const rec of this.prepared) {
      const { line, text } = rec;
      if (!text) continue;
      let body = text;

      const lblM = body.match(/^([A-Za-z_$@?][A-Za-z0-9_$@?]*)\s*:([\s\S]*)$/);
      if (lblM) {
        body = lblM[2].trim();
        if (!body) continue;
      }

      const first = this.firstToken(body);
      const up = first.word.toUpperCase();

      if (up === ".DATA" || up === ".DATA?" || up === ".CONST") {
        this.curSeg = this.segments.get("_DATA"); continue;
      }
      if (up === ".CODE") {
        const rest = body.slice(first.len).trim();
        this.curSeg = this.segments.get(rest ? rest.toUpperCase() : "_CODE"); continue;
      }
      if (up === ".STACK") { this.curSeg = this.segments.get("_STACK"); continue; }
      if (up === ".MODEL") continue;
      if (up === "ASSUME") { this.parseAssume(body.slice(first.len), line); continue; }
      if (up === "END") continue;
      if (up === "ORG") {
        try { this.curSeg.loc = this.evalExpr(body.slice(first.len).trim(), line) & MASK16; }
        catch (e) { this.err(line, e.message); }
        continue;
      }

      const nameM = body.match(/^([A-Za-z_$@?][A-Za-z0-9_$@?]*)\s+([\s\S]+)$/);
      if (nameM) {
        const nm = nameM[1].toUpperCase();
        const rest0 = nameM[2];
        const kw = this.firstToken(rest0).word.toUpperCase();
        if (kw === "SEGMENT") { this.curSeg = this.segments.get(nm); continue; }
        if (kw === "ENDS") { this.curSeg = null; continue; }
        if (kw === "EQU" || kw === "=") continue;
        if (kw === "DB" || kw === "DW" || kw === "DD") {
          const items = rest0.slice(this.firstToken(rest0).len);
          const bytes = this.emitData(items, kw, line);
          this.curSeg.data.push({ off: this.curSeg.loc, bytes });
          this.curSeg.loc += bytes.length;
          continue;
        }
        if (kw === "PROC" || kw === "ENDP") continue;
      }
      if (up === "DB" || up === "DW" || up === "DD") {
        const bytes = this.emitData(body.slice(first.len), up, line);
        this.curSeg.data.push({ off: this.curSeg.loc, bytes });
        this.curSeg.loc += bytes.length;
        continue;
      }

      /* REP 前缀行 */
      if (REP_PREFIXES.has(up)) {
        const after = body.slice(first.len).trim();
        const realM = this.firstToken(after).word.toUpperCase();
        const ir = this.buildIR(realM, body, line);   // 整行含 REP，buildIR 内部剥离
        if (ir) {
          this.program.push(ir);
          this.codeMap.set(ir.segVal + ":" + ir.offset, ir);
          this.curSeg.loc += ir.size;
        }
        continue;
      }

      if (MNEMONICS.has(up) || JCC_ALIAS[up]) {
        const opsText = body.slice(first.len).trim();
        const ir = this.buildIR(up, opsText, line);
        if (ir) {
          this.program.push(ir);
          this.codeMap.set(ir.segVal + ":" + ir.offset, ir);
          this.curSeg.loc += ir.size;
        }
        continue;
      }
    }
  }

  parseAssume(text, line) {
    for (const part of splitTopComma(text)) {
      const m = part.match(/^\s*(CS|DS|SS|ES)\s*:\s*(\w+|NOTHING)\s*$/i);
      if (m) this.assume[m[1].toUpperCase()] = m[2].toUpperCase();
    }
  }

  /* ---------------- 操作数解析 ---------------- */
  buildIR(mnemonic, opsText, line) {
    const seg = this.curSeg;
    const offset = seg.loc;
    let prefix = null;

    /* 串前缀 REP/REPE/REPNE */
    const stripped0 = this.stripRepPrefix(opsText);
    const rep = stripped0.rep;
    const realOps = stripped0.realOps;

    /* 裸串指令（MOVSB 等）无操作数，不可拆分为操作数 */
    const bareStringOp = /^(MOVS|CMPS|SCAS|LODS|STOS)[BW]?$/.test(realOps.trim().toUpperCase());
    const parts = (realOps.trim() && !bareStringOp) ? splitTopComma(realOps) : [];
    let ops;
    try {
      ops = parts.map(p => this.parseOperand(p.trim(), line, mnemonic));
    } catch (e) {
      this.err(line, e.message);
      return null;
    }

    /* 段超越前缀（在第一个操作数上） */
    if (ops[0] && ops[0].segOverride) prefix = ops[0].segOverride;

    /* 推断内存操作数 size */
    const otherReg = ops.find(o => o && o.type === "reg");
    for (const o of ops) {
      if (o && o.type === "mem" && !o.size) {
        o.size = otherReg ? otherReg.size : 16;
      }
    }

    const norm = JCC_ALIAS[mnemonic] || mnemonic;
    const size = this.irSize(norm, ops, mnemonic, realOps);
    const ir = {
      line, segName: seg.name, segVal: seg.baseSeg, offset, size,
      mnemonic: norm, origMnemonic: mnemonic,
      op1: ops[0] || null, op2: ops[1] || null, op3: ops[2] || null,
      prefix, rep,
      cycles: this.estimateCycles(norm, ops, size),
      raw: (rep ? rep + " " : "") + mnemonic + (realOps.trim() ? " " + realOps.trim() : "")
    };
    return ir;
  }

  parseOperand(text, line, mnemonic) {
    let s = text.trim();
    if (!s) throw new Error("空操作数");

    /* 段超越前缀：ES:[..] / DS:xxx */
    let segOverride = null;
    const sov = s.match(/^(ES|CS|SS|DS)\s*:\s*([\s\S]+)$/i);
    if (sov) {
      segOverride = sov[1].toUpperCase();
      s = sov[2].trim();
    }

    /* PTR 尺寸说明 */
    let ptrSize = null;
    const ptrM = s.match(/^(BYTE|WORD|DWORD)\s+PTR\s+([\s\S]+)$/i);
    if (ptrM) {
      ptrSize = ptrM[1].toUpperCase() === "BYTE" ? 8 : 16;
      s = ptrM[2].trim();
    }
    const shortM = s.match(/^(SHORT|NEAR|FAR)\s+PTR\s+([\s\S]+)$/i) ||
                   s.match(/^(SHORT|NEAR|FAR)\s+([\s\S]+)$/i);
    let distance = null;
    if (shortM) { distance = shortM[1].toUpperCase(); s = shortM[2].trim(); }

    /* 内存操作数 [ ... ] */
    const br = s.match(/^([\s\S]*?)\[([\s\S]*?)\]([\s\S]*)$/);
    if (br) {
      const before = br[1].trim();
      const inside = br[2].trim();
      const after = br[3].trim();
      const base = [], toks = inside.split(/[+\-]/).map(x => x.trim()).filter(Boolean);
      let disp = 0;
      for (const t of toks) {
        const up = t.toUpperCase();
        if (REG16[up] !== undefined) {
          if (!["BX","BP","SI","DI"].includes(up)) throw new Error("非法的基址/变址寄存器: " + t);
          base.push(up);
        } else {
          try { disp += this.evalExpr(t, line); }
          catch (e) { throw new Error(e.message); }
        }
      }
      /* 括号外的变量名/位移 */
      if (before) {
        const bUp = before.toUpperCase();
        if (SREG[bUp] !== undefined) segOverride = bUp;
        else {
          const sym = this.symbols.get(bUp);
          if (sym) disp += sym.off;
          else { try { disp += this.evalExpr(before, line); } catch (e) {} }
        }
      }
      if (after) { try { disp += this.evalExpr(after.replace(/^\./, ""), line); } catch (e) {} }
      if (base.length !== new Set(base).size) throw new Error("寻址中寄存器重复");
      return { type: "mem", size: ptrSize, base, disp: disp & MASK16, segOverride };
    }

    /* 寄存器 */
    if (REG16[s.toUpperCase()] !== undefined) return { type: "reg", reg: s.toUpperCase(), size: 16 };
    if (REG8[s.toUpperCase()] !== undefined) return { type: "reg", reg: s.toUpperCase(), size: 8 };
    if (SREG[s.toUpperCase()] !== undefined) return { type: "reg", reg: s.toUpperCase(), size: 16 };

    /* 纯符号：变量=内存，标号/EQU=立即数，段名=段地址 */
    if (/^[A-Za-z_$@?][A-Za-z0-9_$@?]*$/.test(s)) {
      if (s.toUpperCase() === "@DATA") {
        const ds = this.segments.get("_DATA");
        return { type: "imm", value: ds ? ds.baseSeg : 0, size: 16 };
      }
      if (this.segments.has(s.toUpperCase())) {
        return { type: "imm", value: this.segments.get(s.toUpperCase()).baseSeg, size: 16 };
      }
      const sym = this.symbols.get(s.toUpperCase());
      if (sym) {
        if (sym.type === "var") {
          return {
            type: "mem", size: ptrSize || sym.size, base: [],
            disp: sym.off, segOverride
          };
        }
        if (sym.type === "equ") return { type: "imm", value: sym.value & MASK16, size: sym.value > 255 ? 16 : 8 };
        if (sym.type === "label") {
          if (distance === "FAR") {
            return { type: "far", value: sym.off, farSeg: this.segments.get(sym.seg).baseSeg, size: 16 };
          }
          return { type: "imm", value: sym.off, size: 16, targetLabel: s.toUpperCase(), distance };
        }
      }
      throw new Error("未定义的符号: " + s);
    }

    /* OFFSET / SEG 运算符 */
    const offM = s.match(/^OFFSET\s+([\s\S]+)$/i);
    if (offM) {
      const sym = this.symbols.get(offM[1].trim().toUpperCase());
      if (!sym) throw new Error("OFFSET 未定义符号: " + offM[1]);
      return { type: "imm", value: sym.off & MASK16, size: 16 };
    }
    const segM = s.match(/^SEG\s+([\s\S]+)$/i);
    if (segM) {
      const sym = this.symbols.get(segM[1].trim().toUpperCase());
      if (!sym) throw new Error("SEG 未定义符号: " + segM[1]);
      return { type: "imm", value: this.segments.get(sym.seg).baseSeg, size: 16 };
    }

    /* 立即数表达式 */
    let val;
    try { val = this.evalExpr(s, line); }
    catch (e) { throw new Error(e.message); }
    val = val & MASK16;
    return { type: "imm", value: val, size: ptrSize || (val > 255 ? 16 : 8), distance };
  }

  /* ---------------- 指令长度 ---------------- */
  irSize(norm, ops, origMnemonic, realOps) {
    /* 短跳转 2 字节 */
    if (norm === "JMP") {
      if (ops[0] && ops[0].type === "far") return 5;
      if (ops[0] && ops[0].type === "imm" && ops[0].distance === "SHORT") return 2;
      if (ops[0] && ops[0].type === "reg") return 2;
      if (ops[0] && ops[0].type === "mem") return 2 + (ops[0].base.length ? 1 : 2);
      return 3;
    }
    if (norm.startsWith("J") && norm !== "JMP" || ["JCXZ","LOOP","LOOPE","LOOPNE","LOOPZ","LOOPNZ"].includes(norm)) return 2;
    if (norm === "CALL") {
      if (ops[0] && ops[0].type === "far") return 5;
      if (ops[0] && ops[0].type === "reg") return 2;
      if (ops[0] && ops[0].type === "mem") return 2 + (ops[0].base.length ? 1 : 2);
      return 3;
    }
    if (norm === "RET" || norm === "RETF") {
      return ops[0] ? 3 : 1;
    }
    if (norm === "INT") return 2;
    if (NO_OPERAND.has(norm)) {
      if (norm === "RET" || norm === "RETF") return 1;
      return 1;
    }
    /* 通用：依据操作数 */
    let sz = 1;
    const hasMem = ops.some(o => o && o.type === "mem");
    const regOp = ops.find(o => o && o.type === "reg");
    if (hasMem) {
      sz = 2;
      const mem = ops.find(o => o.type === "mem");
      if (mem.segOverride) sz += 1;
      const dispBytes = mem.disp > 255 || (mem.base.length === 0) ? 2 : (mem.disp > 0 ? 1 : 0);
      sz += dispBytes;
      if (ops.some(o => o.type === "imm")) {
        sz += ops.find(o => o.type === "imm").size === 8 ? 1 : 2;
      }
      if (norm === "LEA" || norm === "LDS" || norm === "LES") sz = Math.max(sz, 2 + dispBytes + (mem.segOverride ? 1 : 0));
    } else if (regOp) {
      sz = 2;
      const imm = ops.find(o => o.type === "imm");
      if (imm) sz += imm.size === 8 ? 1 : 2;
    } else {
      const imm = ops[0];
      if (imm) {
        sz = (norm === "IN" || norm === "OUT") ? 2 : (imm.size === 8 ? 2 : 3);
      }
    }
    /* 累加器直接寻址特例 MOV AL,[xxxx] = 3 */
    if (norm === "MOV" && regOp && (regOp.reg === "AX" || regOp.reg === "AL")) {
      const mem = ops.find(o => o.type === "mem");
      if (mem && mem.base.length === 0 && !mem.segOverride) sz = 3;
    }
    return sz;
  }

  estimateSize(mnemonic, opsText, line) {
    /* 第一遍用的近似长度（操作数未完全解析，按文本粗估） */
    const up = JCC_ALIAS[mnemonic] || mnemonic;
    if (up === "JMP") return /SHORT/i.test(opsText) ? 2 : 3;
    if ((up.startsWith("J") && up !== "JMP") || ["JCXZ","LOOP","LOOPE","LOOPNE","LOOPZ","LOOPNZ"].includes(up)) return 2;
    if (up === "CALL") return 3;
    if (up === "RET" || up === "RETF") return opsText.trim() ? 3 : 1;
    if (up === "INT") return 2;
    if (NO_OPERAND.has(up)) return 1;
    if (/\[/.test(opsText)) {
      let sz = 2;
      if (/^(ES|CS|SS|DS)\s*:/i.test(opsText)) sz++;
      if (/[0-9A-F]{3,}H/i.test(opsText) || !/[+\]]\s*$/.test(opsText) && /[0-9]/.test(opsText)) sz++;
      if (/,/.test(opsText)) {
        const imm = opsText.split(",").pop();
        if (/[0-9A-F]{2,}H/i.test(imm) || /^[0-9]{3,}/.test(imm.trim())) sz++;
      }
      return sz;
    }
    if (/,/.test(opsText)) {
      const imm = opsText.split(",").pop().trim();
      if (/[0-9A-F]{2,}H/i.test(imm) || /^[0-9]{3,}/.test(imm)) return 4;
      return 3;
    }
    return 2;
  }

  estimateCycles(norm, ops, size) {
    const hasMem = ops && ops.some(o => o && o.type === "mem");
    if (norm === "INT") return 51;
    if (norm === "CALL") return hasMem ? 21 : 16;
    if (norm === "RET" || norm === "RETF") return hasMem ? 12 : 8;
    if (norm === "JMP") return hasMem ? 18 : 15;
    if (norm.startsWith("J") || ["LOOP","JCXZ"].includes(norm)) return 16;
    if (hasMem) return 14;
    if (["MUL","IMUL","DIV","IDIV"].includes(norm)) return 70;
    return 3;
  }

  /* ---------------- 表达式 ---------------- */
  evalExpr(s, line) {
    const tk = tokenizeExpr(s);
    if (!tk.length) throw new Error("空表达式");
    const ep = new ExprParser(tk, this, line);
    return ep.parse();
  }

  firstToken(s) {
    const m = s.match(/^\.[A-Za-z]+|^[A-Za-z_$@?][A-Za-z0-9_$@?]*|^[=]/);
    return { word: m ? m[0] : "", len: m ? m[0].length : 0 };
  }
  tokenBefore(body, first) {
    const m = body.match(/^([A-Za-z_$@?][A-Za-z0-9_$@?]*)\s+/);
    return m ? m[1].toUpperCase() : "";
  }

  /* ---------------- 结果 ---------------- */
  buildResult() {
    /* 入口与初始寄存器 */
    const codeSegs = this.segOrder.filter(s => s.isCode);
    const dataSegs = this.segOrder.filter(s => !s.isCode && !s.isStack);
    const stackSeg = this.segOrder.find(s => s.isStack);
    const entrySeg = codeSegs[0];
    let entryOff = 0;
    if (this.entry) {
      const sym = this.symbols.get(this.entry);
      if (sym) entryOff = sym.off;
      else this.errors.push({ line: 0, msg: "入口标号未定义: " + this.entry });
    }

    const init = {
      CS: entrySeg ? entrySeg.baseSeg : 0x1000,
      IP: entryOff,
      DS: dataSegs[0] ? dataSegs[0].baseSeg : (entrySeg ? entrySeg.baseSeg : 0x1000),
      ES: dataSegs[0] ? dataSegs[0].baseSeg : (entrySeg ? entrySeg.baseSeg : 0x1000),
      SS: stackSeg.baseSeg,
      SP: stackSeg.size
    };

    const dataLoads = [];
    for (const seg of this.segOrder) {
      for (const d of seg.data) {
        dataLoads.push({
          phys: Memory.physical(seg.baseSeg, d.off),
          bytes: d.bytes, segName: seg.name
        });
      }
    }

    /* 代码段填充 NOP 占位，让内存视图有内容 */
    for (const ir of this.program) {
      dataLoads.push({
        phys: Memory.physical(ir.segVal, ir.offset),
        bytes: new Array(ir.size).fill(0x90),
        segName: ir.segName, isCode: true
      });
    }

    return {
      errors: this.errors,
      program: this.program,
      codeMap: this.codeMap,
      dataLoads,
      init,
      symbols: [...this.symbols.entries()].map(([name, v]) => ({ name, ...v })),
      segments: this.segOrder.map(s => ({ name: s.name, base: s.baseSeg, size: s.size, isCode: s.isCode }))
    };
  }
}
