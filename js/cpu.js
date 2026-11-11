/* ============================================================
   cpu.js — 8086 CPU 核心状态
   通用/段寄存器、FLAGS 标志位、有效地址计算、堆栈、操作数读写
   指令执行逻辑见 instructions.js
   ============================================================ */

/* 16 位通用寄存器编码（与 8086 机器码一致） */
const REG16 = { AX:0, CX:1, DX:2, BX:3, SP:4, BP:5, SI:6, DI:7 };
/* 8 位寄存器编码 */
const REG8  = { AL:0, CL:1, DL:2, BL:3, AH:4, CH:5, DH:6, BH:7 };
/* 段寄存器编码 */
const SREG  = { ES:0, CS:1, SS:2, DS:3 };

/* FLAGS 各位 */
const FLAGBIT = {
  CF: 0x001,  // 进位
  PF: 0x004,  // 奇偶
  AF: 0x010,  // 辅助进位
  ZF: 0x040,  // 零
  SF: 0x080,  // 符号
  TF: 0x100,  // 单步陷阱
  IF: 0x200,  // 中断允许
  DF: 0x400,  // 方向
  OF: 0x800   // 溢出
};

const REG16_NAMES = ["AX","CX","DX","BX","SP","BP","SI","DI"];
const SREG_NAMES  = ["ES","CS","SS","DS"];

class CPU {
  constructor(mem) {
    this.mem = mem;
    this.bus = null;                 // DOS/BIOS 中断总线，由 app 注入
    this.reset();
  }

  reset() {
    this.r16 = new Uint16Array(8);   // 通用寄存器
    this.sreg = new Uint16Array(4);  // 段寄存器
    this.IP = 0;
    this.flags = 0x0202;             // 上电默认：IF=1, PF=1（常见初始状态）

    this.running = false;
    this.halted = false;
    this.waiting = false;            // 等待 IO（阻塞键盘输入）
    this.instrCount = 0;
    this.cycles = 0;

    this.program = [];               // IR 数组
    this.codeMap = new Map();        // "段值:偏移" -> IR
    this.breakpoints = new Set();    // "段值:偏移"
    this.lastIR = null;
    this.error = null;
  }

  /* ---------- 程序加载 ---------- */
  loadProgram(program, codeMap, init) {
    this.program = program;
    this.codeMap = codeMap;
    if (init) {
      this.sreg[SREG.CS] = init.CS >>> 0;
      this.sreg[SREG.DS] = init.DS >>> 0;
      this.sreg[SREG.ES] = init.ES >>> 0;
      this.sreg[SREG.SS] = init.SS >>> 0;
      this.IP = init.IP >>> 0;
      this.r16[REG16.SP] = init.SP >>> 0;
    }
    this.halted = false;
    this.waiting = false;
    this.running = false;
    this.error = null;
    this.instrCount = 0;
    this.cycles = 0;
  }

  /* ---------- 寄存器访问 ---------- */
  getReg16(name) { return this.r16[REG16[name]]; }
  setReg16(name, val) { this.r16[REG16[name]] = val & MASK16; }

  getReg8(name) {
    const idx = REG8[name];
    const parent = this.r16[idx & 3];      // 0-3 对应 AX CX DX BX
    return (idx < 4) ? (parent & 0xFF) : ((parent >> 8) & 0xFF);
  }
  setReg8(name, val) {
    const idx = REG8[name];
    const pidx = idx & 3;
    const old = this.r16[pidx];
    const v = val & 0xFF;
    this.r16[pidx] = (idx < 4) ? ((old & 0xFF00) | v) : ((old & 0xFF) | (v << 8));
  }

  /* 按名字自动判断 8/16 位 */
  getReg(name) {
    if (REG16[name] !== undefined) return this.getReg16(name);
    if (SREG[name] !== undefined) return this.getSeg(name);
    return this.getReg8(name);
  }
  setReg(name, val) {
    if (REG16[name] !== undefined) this.setReg16(name, val);
    else if (SREG[name] !== undefined) this.setSeg(name, val);
    else this.setReg8(name, val);
  }

  getSeg(name) { return this.sreg[SREG[name]]; }
  setSeg(name, val) { this.sreg[SREG[name]] = val & MASK16; }

  /* ---------- 标志位 ---------- */
  getFlag(name) { return (this.flags & FLAGBIT[name]) ? 1 : 0; }
  setFlag(name, on) {
    if (on) this.flags |= FLAGBIT[name];
    else this.flags &= ~FLAGBIT[name];
  }
  getFlagsWord() { return this.flags & MASK16; }
  setFlagsWord(v) { this.flags = v & MASK16; }

  /* ---------- 有效地址 ---------- */
  /* mem 操作数: { base:[BX/BP/SI/DI...], disp, segOverride } */
  effectiveAddr(op) {
    let ea = op.disp || 0;
    let usesBP = false;
    if (op.base) {
      for (const b of op.base) {
        ea += this.getReg16(b);
        if (b === "BP") usesBP = true;
      }
    }
    ea &= MASK16;
    let segName;
    if (op.segOverride) segName = op.segOverride;
    else segName = usesBP ? "SS" : "DS";
    return { ea, phys: Memory.physical(this.getSeg(segName), ea), segName };
  }

  /* ---------- 内存读写（按操作数 size） ---------- */
  memRead(op) {
    const { phys } = this.effectiveAddr(op);
    return op.size === 8 ? this.mem.readByte(phys) : this.mem.readWord(phys);
  }
  memWrite(op, val) {
    const { phys } = this.effectiveAddr(op);
    if (op.size === 8) this.mem.writeByte(phys, val);
    else this.mem.writeWord(phys, val);
  }

  /* ---------- 堆栈 ---------- */
  push16(val) {
    let sp = this.r16[REG16.SP] - 2;
    sp &= MASK16;
    this.r16[REG16.SP] = sp;
    this.mem.writeWord(Memory.physical(this.sreg[SREG.SS], sp), val & MASK16);
  }
  pop16() {
    const sp = this.r16[REG16.SP];
    const val = this.mem.readWord(Memory.physical(this.sreg[SREG.SS], sp));
    this.r16[REG16.SP] = (sp + 2) & MASK16;
    return val;
  }

  /* ---------- 通用操作数读写 ---------- */
  readOp(op) {
    if (op.type === "imm") return op.value & MASK16;
    if (op.type === "reg") return this.getReg(op.reg);
    if (op.type === "mem") return this.memRead(op);
    return 0;
  }
  writeOp(op, val) {
    if (op.type === "reg") this.setReg(op.reg, val);
    else if (op.type === "mem") this.memWrite(op, val);
  }

  /* ---------- 标志位计算辅助 ---------- */
  static parity(v) {
    let x = v & 0xFF, c = 0;
    while (x) { c += x & 1; x >>= 1; }
    return (c & 1) === 0 ? 1 : 0;   // 偶数个 1 -> PF=1
  }

  /* 加法后更新全部标志 */
  flagsAfterAdd(a, b, res, bits) {
    const mask = (1 << bits) - 1;
    const sign = 1 << (bits - 1);
    const half = bits === 8 ? 0x10 : 0x10;
    this.setFlag("ZF", (res & mask) === 0);
    this.setFlag("SF", !!(res & sign));
    this.setFlag("PF", CPU.parity(res));
    this.setFlag("CF", res > mask);
    this.setFlag("AF", ((a & 0x0F) + (b & 0x0F)) > 0x0F);
    const sa = toSigned(a, bits), sb = toSigned(b, bits);
    const sr = sa + sb;
    this.setFlag("OF", sr > (mask >> 1) || sr < -(1 << (bits - 1)));
  }

  /* 减法后更新全部标志（a - b） */
  flagsAfterSub(a, b, res, bits) {
    const mask = (1 << bits) - 1;
    const sign = 1 << (bits - 1);
    this.setFlag("ZF", (res & mask) === 0);
    this.setFlag("SF", !!(res & sign));
    this.setFlag("PF", CPU.parity(res));
    this.setFlag("CF", b > a);                    // 借位
    this.setFlag("AF", (b & 0x0F) > (a & 0x0F));
    const sa = toSigned(a, bits), sb = toSigned(b, bits);
    const sr = sa - sb;
    this.setFlag("OF", sr > (mask >> 1) || sr < -(1 << (bits - 1)));
  }

  /* 逻辑运算后更新标志：CF=OF=0，更新 ZF/SF/PF */
  flagsAfterLogic(res, bits) {
    const mask = (1 << bits) - 1;
    const sign = 1 << (bits - 1);
    this.setFlag("ZF", (res & mask) === 0);
    this.setFlag("SF", !!(res & sign));
    this.setFlag("PF", CPU.parity(res));
    this.setFlag("CF", 0);
    this.setFlag("OF", 0);
    this.setFlag("AF", 0);
  }

  /* ---------- 取指与单步 ---------- */
  currentIR() {
    return this.codeMap.get(this.sreg[SREG.CS] + ":" + this.IP) || null;
  }

  key(segVal, ip) { return segVal + ":" + ip; }

  step(ignoreBp) {
    if (this.halted) return { halt: true };
    const ir = this.currentIR();
    if (!ir) {
      this.halted = true;
      this.error = "CS:IP 未指向有效指令（程序可能缺少退出中断 INT 21h/4Ch）";
      return { error: this.error };
    }
    if (!ignoreBp && this.breakpoints.has(this.key(this.sreg[SREG.CS], this.IP))) {
      return { breakpoint: true, ir };
    }
    this.lastIR = ir;
    const r = this.execute(ir);
    this.instrCount++;
    this.cycles += ir.cycles || 1;
    return r || { ok: true, ir };
  }
}
