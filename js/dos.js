/* ============================================================
   dos.js — DOS/BIOS 中断总线（浏览器端）
   维护 80x25 字符屏幕模型、光标、异步键盘输入状态机
   INT 21h / INT 10h / INT 16h / INT 20h
   ============================================================ */

const SCR_COLS = 80;
const SCR_ROWS = 25;

class DosBus {
  constructor() {
    this.reset();
    this.onWaitChange = null;      // app 回调：等待状态变化
  }

  reset() {
    this.rows = [];
    for (let r = 0; r < SCR_ROWS; r++) this.rows.push(new Uint8Array(SCR_COLS));
    this.cur = { row: 0, col: 0 };
    this.inputMode = null;         // null | 'char' | 'line'
    this.lineCtx = null;
    this.echo = true;
    this.cpu = null;
  }

  /* ---------------- 屏幕操作 ---------------- */
  scroll() {
    for (let r = 0; r < SCR_ROWS - 1; r++) this.rows[r].set(this.rows[r + 1]);
    this.rows[SCR_ROWS - 1].fill(0);
  }

  newline() {
    this.cur.row++;
    if (this.cur.row >= SCR_ROWS) { this.scroll(); this.cur.row = SCR_ROWS - 1; }
  }

  putChar(c) {
    c = c & 0xFF;
    if (c === 0x0D) { this.cur.col = 0; return; }          // CR
    if (c === 0x0A) { this.newline(); return; }            // LF
    if (c === 0x08) { if (this.cur.col > 0) this.cur.col--; return; } // BS
    if (c === 0x09) {                                       // Tab
      this.cur.col = (Math.floor(this.cur.col / 8) + 1) * 8;
      if (this.cur.col >= SCR_COLS) { this.cur.col = 0; this.newline(); }
      return;
    }
    if (c === 0x07) return;                                // BEL
    if (c === 0) return;
    this.rows[this.cur.row][this.cur.col] = c;
    this.cur.col++;
    if (this.cur.col >= SCR_COLS) { this.cur.col = 0; this.newline(); }
  }

  /* 输出 $ 结尾字符串 */
  writeDollarString(phys) {
    let p = phys;
    let c = this.cpu.mem.readByte(p);
    while (c !== 0x24) {           // '$'
      this.putChar(c);
      p = (p + 1) & 0xFFFFF;
      c = this.cpu.mem.readByte(p);
    }
  }

  /* ---------------- 中断入口 ---------------- */
  int(n, cpu) {
    this.cpu = cpu;
    if (n === 0x20) return "HALT";
    if (n === 0x21) return this.int21();
    if (n === 0x10) return this.int10();
    if (n === 0x16) return this.int16();
    /* 其他中断：忽略并继续 */
    return;
  }

  int21() {
    const cpu = this.cpu;
    const ah = cpu.getReg("AH");

    switch (ah) {
      case 0x00: return "HALT";
      case 0x4C: return "HALT";

      case 0x02:                                        // 字符输出
      case 0x06:
        this.putChar(cpu.getReg("DL"));
        return;

      case 0x05:                                        // 打印机 -> 屏幕
        this.putChar(cpu.getReg("DL"));
        return;

      case 0x09: {                                      // $ 字符串
        const phys = Memory.physical(cpu.getSeg("DS"), cpu.getReg("DX"));
        this.writeDollarString(phys);
        return;
      }

      case 0x01:                                        // 带回显字符输入
        this.beginCharInput(true);
        return "WAIT";
      case 0x07:                                        // 无回显
      case 0x08:
        this.beginCharInput(false);
        return "WAIT";

      case 0x0B:                                        // 键盘状态
        cpu.setReg("AL", 0);
        return;

      case 0x0A:                                        // 缓冲行输入
        this.beginLineInput();
        return "WAIT";

      case 0x25:                                        // 设置中断向量，模拟忽略
      case 0x35:                                        // 取中断向量，返回0
        cpu.setReg("ES", 0);
        return;

      default:
        /* 未实现的功能号：忽略继续 */
        return;
    }
  }

  int10() {
    const cpu = this.cpu;
    const ah = cpu.getReg("AH");
    if (ah === 0x0E) {                                  // 电传输出
      this.putChar(cpu.getReg("AL"));
      return;
    }
    if (ah === 0x02 || ah === 0x03) return;             // 光标/读光标，忽略
    if (ah === 0x00 || ah === 0x06 || ah === 0x07) return; // 模式/滚屏，忽略
    return;
  }

  int16() {
    const ah = this.cpu.getReg("AH");
    if (ah === 0x01 || ah === 0x00) {
      if (ah === 0x01) { this.cpu.setReg("ZF", 1); return; }
      this.beginCharInput(false);
      return "WAIT";
    }
    return;
  }

  /* ---------------- 键盘输入状态机 ---------------- */
  beginCharInput(echo) {
    this.inputMode = "char";
    this.echo = echo;
    if (this.onWaitChange) this.onWaitChange(true);
  }

  beginLineInput() {
    const cpu = this.cpu;
    const phys = Memory.physical(cpu.getSeg("DS"), cpu.getReg("DX"));
    this.lineCtx = {
      phys,
      max: cpu.mem.readByte(phys),
      chars: []
    };
    this.inputMode = "line";
    if (this.onWaitChange) this.onWaitChange(true);
  }

  /* app 转发键盘事件：key 为 "Enter"/"Backspace"/单字符 */
  handleKey(key) {
    if (!this.inputMode) return false;

    if (this.inputMode === "char") {
      if (key === "Enter") { this.finishChar(0x0D); return true; }
      if (key.length === 1) { this.finishChar(key.charCodeAt(0) & 0xFF); return true; }
      return false;
    }

    if (this.inputMode === "line") {
      const ctx = this.lineCtx;
      if (key === "Enter") { this.finishLine(); return true; }
      if (key === "Backspace") {
        if (ctx.chars.length) {
          ctx.chars.pop();
          this.putChar(0x08); this.putChar(0x20); this.putChar(0x08);
        }
        return true;
      }
      if (key.length === 1) {
        const code = key.charCodeAt(0);
        if (ctx.chars.length < ctx.max - 1) {
          ctx.chars.push(code);
          this.putChar(code);
        }
        return true;
      }
    }
    return false;
  }

  finishChar(code) {
    this.cpu.setReg("AL", code);
    if (this.echo) this.putChar(code);
    this.inputMode = null;
    if (this.onWaitChange) this.onWaitChange(false);
    this.cpu.completeIntWait();
  }

  finishLine() {
    const ctx = this.lineCtx;
    const cpu = this.cpu;
    cpu.mem.writeByte(ctx.phys + 1, ctx.chars.length);
    for (let i = 0; i < ctx.chars.length; i++)
      cpu.mem.writeByte(ctx.phys + 2 + i, ctx.chars[i]);
    this.putChar(0x0D); this.putChar(0x0A);
    this.inputMode = null;
    this.lineCtx = null;
    if (this.onWaitChange) this.onWaitChange(false);
    cpu.completeIntWait();
  }

  /* ---------------- 渲染数据 ---------------- */
  getScreenText() {
    return this.rows
      .map(r => Array.from(r).map(c => c === 0 ? " " : String.fromCharCode(c)).join(""))
      .join("\n");
  }
}
