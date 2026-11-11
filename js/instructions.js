/* ============================================================
   instructions.js — 8086 指令集解释执行
   挂接到 CPU.prototype.execute，由 cpu.step() 调用
   约定：正常指令执行后 IP 自动 += size；跳转/等待/停机不推进
   ============================================================ */

/* 条件跳转判定表（规范助记符），普通函数以便 .call(cpu) 绑定 this */
const COND = {
  JZ:  function () { return this.getFlag("ZF") === 1; },
  JNZ: function () { return this.getFlag("ZF") === 0; },
  JB:  function () { return this.getFlag("CF") === 1; },
  JAE: function () { return this.getFlag("CF") === 0; },
  JBE: function () { return this.getFlag("CF") === 1 || this.getFlag("ZF") === 1; },
  JA:  function () { return this.getFlag("CF") === 0 && this.getFlag("ZF") === 0; },
  JL:  function () { return this.getFlag("SF") !== this.getFlag("OF"); },
  JGE: function () { return this.getFlag("SF") === this.getFlag("OF"); },
  JLE: function () { return this.getFlag("ZF") === 1 || this.getFlag("SF") !== this.getFlag("OF"); },
  JG:  function () { return this.getFlag("ZF") === 0 && this.getFlag("SF") === this.getFlag("OF"); },
  JO:  function () { return this.getFlag("OF") === 1; },
  JNO: function () { return this.getFlag("OF") === 0; },
  JS:  function () { return this.getFlag("SF") === 1; },
  JNS: function () { return this.getFlag("SF") === 0; },
  JP:  function () { return this.getFlag("PF") === 1; },
  JNP: function () { return this.getFlag("PF") === 0; }
};

CPU.prototype.execute = function (ir) {
  const m = ir.mnemonic;
  const op1 = ir.op1, op2 = ir.op2;
  let r;

  switch (m) {

    /* ================= 数据传送 ================= */
    case "MOV":
      this.writeOp(op1, this.readOp(op2));
      break;

    case "PUSH": {
      this.push16(this.readOp(op1));
      break;
    }
    case "POP": {
      this.writeOp(op1, this.pop16());
      break;
    }
    case "XCHG": {
      const a = this.readOp(op1), b = this.readOp(op2);
      this.writeOp(op1, b); this.writeOp(op2, a);
      break;
    }
    case "LEA": {
      const { ea } = this.effectiveAddr(op2);
      this.writeOp(op1, ea);
      break;
    }
    case "LDS":
    case "LES": {
      const { phys } = this.effectiveAddr(op2);
      const off = this.mem.readWord(phys);
      const seg = this.mem.readWord((phys + 2) & 0xFFFFF);
      this.writeOp(op1, off);
      this.setSeg(m === "LDS" ? "DS" : "ES", seg);
      break;
    }
    case "XLAT": {
      const ea = (this.getReg("BX") + this.getReg("AL")) & MASK16;
      this.setReg("AL", this.mem.readByte(Memory.physical(this.getSeg("DS"), ea)));
      break;
    }
    case "LAHF":
      this.setReg("AH", this.getFlagsWord() & 0xFF);
      break;
    case "SAHF":
      this.setFlagsWord((this.getFlagsWord() & 0xFF00) | (this.getReg("AH") & 0xFF));
      break;
    case "PUSHF":
      this.push16(this.getFlagsWord());
      break;
    case "POPF":
      this.setFlagsWord(this.pop16());
      break;

    /* ================= 算术运算 ================= */
    case "ADD":
    case "ADC": {
      const bits = op1.size, c = m === "ADC" ? this.getFlag("CF") : 0;
      const a = this.readOp(op1), b = this.readOp(op2) + c, res = a + b;
      this.flagsAfterAdd(a, b, res, bits);
      this.writeOp(op1, res);
      break;
    }
    case "SUB":
    case "SBB": {
      const bits = op1.size, c = m === "SBB" ? this.getFlag("CF") : 0;
      const a = this.readOp(op1), b = this.readOp(op2) + c, res = a - b;
      this.flagsAfterSub(a, b, res, bits);
      this.writeOp(op1, res);
      break;
    }
    case "CMP": {
      const bits = op1.size;
      const a = this.readOp(op1), b = this.readOp(op2), res = a - b;
      this.flagsAfterSub(a, b, res, bits);
      break;
    }
    case "INC": {
      const bits = op1.size, cf = this.getFlag("CF");
      const a = this.readOp(op1), res = a + 1;
      this.flagsAfterAdd(a, 1, res, bits);
      this.setFlag("CF", cf);           // INC 不影响 CF
      this.writeOp(op1, res);
      break;
    }
    case "DEC": {
      const bits = op1.size, cf = this.getFlag("CF");
      const a = this.readOp(op1), res = a - 1;
      this.flagsAfterSub(a, 1, res, bits);
      this.setFlag("CF", cf);
      this.writeOp(op1, res);
      break;
    }
    case "NEG": {
      const bits = op1.size, a = this.readOp(op1), res = (0 - a);
      this.flagsAfterSub(0, a, res, bits);
      this.writeOp(op1, res);
      break;
    }

    case "MUL":
    case "IMUL": {
      const signed = m === "IMUL";
      if (op1.size === 8) {
        const a = signed ? toSigned(this.getReg("AL"), 8) : this.getReg("AL");
        const b = signed ? toSigned(this.readOp(op1), 8) : this.readOp(op1);
        const r = a * b;
        this.setReg("AX", r);
        const hi = (r >> 8) & 0xFF;
        const setf = signed ? (hi !== ((r & 0x80) ? 0xFF : 0x00)) : hi !== 0;
        this.setFlag("CF", setf); this.setFlag("OF", setf);
      } else {
        const a = signed ? toSigned(this.getReg("AX"), 16) : this.getReg("AX");
        const b = signed ? toSigned(this.readOp(op1), 16) : this.readOp(op1);
        const r = a * b;
        this.setReg("AX", r); this.setReg("DX", (r >> 16) & MASK16);
        const hi = (r >> 16) & MASK16;
        const setf = signed ? (hi !== ((r & 0x8000) ? 0xFFFF : 0x0000)) : hi !== 0;
        this.setFlag("CF", setf); this.setFlag("OF", setf);
      }
      break;
    }

    case "DIV":
    case "IDIV": {
      const signed = m === "IDIV";
      if (op1.size === 8) {
        const divisor = this.readOp(op1);
        const dividend = signed ? toSigned(this.getReg("AX"), 16) : this.getReg("AX");
        if (divisor === 0 || Math.abs(Math.floor(dividend / (signed ? toSigned(divisor, 8) : divisor))) > 255) {
          this.raiseDivError(); r = { noAdvance: true, error: "除法错误（除数为 0 或商溢出），触发 INT 0" }; break;
        }
        const d = signed ? toSigned(divisor, 8) : divisor;
        let q = Math.trunc(dividend / d), rem = dividend - q * d;
        this.setReg("AL", q); this.setReg("AH", rem);
      } else {
        const divisor = this.readOp(op1);
        const d = signed ? toSigned(divisor, 16) : divisor;
        const dividend = ((this.getReg("DX") << 16) | this.getReg("AX"));
        const sdiv = signed ? toSigned(dividend, 32) : dividend;
        if (d === 0 || Math.abs(Math.trunc(sdiv / d)) > 65535) {
          this.raiseDivError(); r = { noAdvance: true, error: "除法错误（除数为 0 或商溢出），触发 INT 0" }; break;
        }
        const q = Math.trunc(sdiv / d), rem = sdiv - q * d;
        this.setReg("AX", q); this.setReg("DX", rem);
      }
      break;
    }

    case "CBW":
      this.setReg("AX", this.getReg("AL") & 0x80
        ? (this.getReg("AL") | 0xFF00) : this.getReg("AL"));
      break;
    case "CWD":
      this.setReg("DX", this.getReg("AX") & 0x8000 ? 0xFFFF : 0);
      break;

    /* BCD 调整 */
    case "DAA": {
      let al = this.getReg("AL");
      let cf = this.getFlag("CF");
      if ((al & 0x0F) > 9 || this.getFlag("AF")) { al = (al + 6) & 0xFF; this.setFlag("AF", 1); }
      if (al > 0x9F || cf) { al = (al + 0x60) & 0xFF; cf = 1; }
      this.setReg("AL", al);
      this.setFlag("CF", cf);
      this.flagsAfterLogic(al, 8);
      this.setFlag("CF", cf);
      break;
    }
    case "DAS": {
      let al = this.getReg("AL"), cf = this.getFlag("CF");
      if ((al & 0x0F) > 9 || this.getFlag("AF")) { al = (al - 6) & 0xFF; this.setFlag("AF", 1); }
      if (this.getReg("AL") > 0x9F || cf) { al = (al - 0x60) & 0xFF; cf = 1; }
      this.setReg("AL", al);
      this.flagsAfterLogic(al, 8);
      this.setFlag("CF", cf);
      break;
    }
    case "AAA": {
      let al = this.getReg("AL");
      if ((al & 0x0F) > 9 || this.getFlag("AF")) {
        this.setReg("AL", (al + 6) & 0x0F);
        this.setReg("AH", this.getReg("AH") + 1);
        this.setFlag("AF", 1); this.setFlag("CF", 1);
      } else { this.setFlag("AF", 0); this.setFlag("CF", 0); }
      break;
    }
    case "AAS": {
      let al = this.getReg("AL");
      if ((al & 0x0F) > 9 || this.getFlag("AF")) {
        this.setReg("AL", (al - 6) & 0x0F);
        this.setReg("AH", this.getReg("AH") - 1);
        this.setFlag("AF", 1); this.setFlag("CF", 1);
      } else { this.setFlag("AF", 0); this.setFlag("CF", 0); }
      break;
    }
    case "AAM": {
      const al = this.getReg("AL");
      this.setReg("AH", Math.floor(al / 10));
      this.setReg("AL", al % 10);
      this.flagsAfterLogic(this.getReg("AL"), 8);
      break;
    }
    case "AAD": {
      const v = (this.getReg("AH") * 10 + this.getReg("AL")) & 0xFF;
      this.setReg("AL", v); this.setReg("AH", 0);
      this.flagsAfterLogic(v, 8);
      break;
    }

    /* ================= 逻辑运算 ================= */
    case "AND":
    case "OR":
    case "XOR": {
      const bits = op1.size;
      const a = this.readOp(op1), b = this.readOp(op2);
      const res = m === "AND" ? (a & b) : m === "OR" ? (a | b) : (a ^ b);
      this.flagsAfterLogic(res, bits);
      this.writeOp(op1, res);
      break;
    }
    case "TEST": {
      const res = this.readOp(op1) & this.readOp(op2);
      this.flagsAfterLogic(res, op1.size);
      break;
    }
    case "NOT":
      this.writeOp(op1, ~this.readOp(op1));
      break;

    /* ================= 移位/循环移位 ================= */
    case "SHL": case "SAL": case "SHR": case "SAR":
    case "ROL": case "ROR": case "RCL": case "RCR": {
      const bits = op1.size;
      const mask = (1 << bits) - 1, sign = 1 << (bits - 1);
      let count;
      if (op2.reg === "CL") count = this.getReg("CL");
      else count = this.readOp(op2);
      count &= 0x1F;
      let val = this.readOp(op1);
      let cf = this.getFlag("CF");
      const rotate = m === "ROL" || m === "ROR" || m === "RCL" || m === "RCR";

      for (let i = 0; i < count; i++) {
        switch (m) {
          case "SHL": case "SAL":
            cf = (val >> (bits - 1)) & 1;
            val = (val << 1) & mask;
            break;
          case "SHR":
            cf = val & 1;
            val = (val >> 1) & mask;
            break;
          case "SAR":
            cf = val & 1;
            val = ((val >> 1) | (val & sign ? sign : 0)) & mask;
            break;
          case "ROL":
            cf = (val >> (bits - 1)) & 1;
            val = ((val << 1) & mask) | cf;
            break;
          case "ROR":
            cf = val & 1;
            val = (val >> 1) | (cf << (bits - 1));
            break;
          case "RCL": {
            const old = cf;
            cf = (val >> (bits - 1)) & 1;
            val = ((val << 1) & mask) | old;
            break;
          }
          case "RCR": {
            const old = cf;
            cf = val & 1;
            val = (val >> 1) | (old << (bits - 1));
            break;
          }
        }
      }
      this.setFlag("CF", cf);
      if (count === 1) {
        if (m === "SHL" || m === "SAL") this.setFlag("OF", ((val >> (bits - 1)) & 1) !== cf);
        else if (m === "SHR") this.setFlag("OF", (val >> (bits - 1)) & 1);
        else if (m === "SAR") this.setFlag("OF", 0);
      }
      if (!rotate) this.flagsAfterLogic(val, bits);
      this.setFlag("CF", cf);
      this.writeOp(op1, val);
      break;
    }

    /* ================= 串操作 ================= */
    case "MOVS": case "MOVSB": case "MOVSW":
    case "CMPS": case "CMPSB": case "CMPSW":
    case "SCAS": case "SCASB": case "SCASW":
    case "LODS": case "LODSB": case "LODSW":
    case "STOS": case "STOSB": case "STOSW": {
      const bits = m.endsWith("W") ? 16 : 8;
      const delta = bits === 8 ? 1 : 2;
      const step = () => (this.getFlag("DF") ? -delta : delta);

      const doOne = () => {
        const si = this.getReg("SI"), di = this.getReg("DI");
        const srcP = Memory.physical(this.getSeg("DS"), si);
        const dstP = Memory.physical(this.getSeg("ES"), di);
        if (m.startsWith("MOVS")) {
          const v = bits === 8 ? this.mem.readByte(srcP) : this.mem.readWord(srcP);
          if (bits === 8) this.mem.writeByte(dstP, v); else this.mem.writeWord(dstP, v);
        } else if (m.startsWith("CMPS")) {
          const a = bits === 8 ? this.mem.readByte(srcP) : this.mem.readWord(srcP);
          const b = bits === 8 ? this.mem.readByte(dstP) : this.mem.readWord(dstP);
          this.flagsAfterSub(a, b, a - b, bits);
        } else if (m.startsWith("SCAS")) {
          const a = bits === 8 ? this.getReg("AL") : this.getReg("AX");
          const b = bits === 8 ? this.mem.readByte(dstP) : this.mem.readWord(dstP);
          this.flagsAfterSub(a, b, a - b, bits);
        } else if (m.startsWith("LODS")) {
          const v = bits === 8 ? this.mem.readByte(srcP) : this.mem.readWord(srcP);
          if (bits === 8) this.setReg("AL", v); else this.setReg("AX", v);
        } else if (m.startsWith("STOS")) {
          const v = bits === 8 ? this.getReg("AL") : this.getReg("AX");
          if (bits === 8) this.mem.writeByte(dstP, v); else this.mem.writeWord(dstP, v);
        }
        this.setReg("SI", (si + step()) & MASK16);
        this.setReg("DI", (di + step()) & MASK16);
      };

      if (ir.rep) {
        let guard = 0;
        while (this.getReg("CX") !== 0 && guard < 200000) {
          doOne();
          this.setReg("CX", this.getReg("CX") - 1);
          if (ir.rep === "REPE" && (m.startsWith("CMPS") || m.startsWith("SCAS")) && this.getFlag("ZF") === 0) break;
          if (ir.rep === "REPNE" && (m.startsWith("CMPS") || m.startsWith("SCAS")) && this.getFlag("ZF") === 1) break;
          guard++;
        }
      } else {
        doOne();
      }
      break;
    }

    /* ================= 控制转移 ================= */
    case "JMP":
      if (op1.type === "far") {
        this.setSeg("CS", op1.farSeg);
        this.IP = op1.value & MASK16;
        return { noAdvance: true };
      }
      this.IP = (op1.type === "imm" ? op1.value : this.readOp(op1)) & MASK16;
      return { noAdvance: true };

    case "CALL": {
      const next = (this.IP + ir.size) & MASK16;
      if (op1.type === "far") {
        this.push16(this.sreg[SREG.CS]);
        this.push16(next);
        this.setSeg("CS", op1.farSeg);
        this.IP = op1.value & MASK16;
        return { noAdvance: true };
      }
      this.push16(next);
      this.IP = (op1.type === "imm" ? op1.value : this.readOp(op1)) & MASK16;
      return { noAdvance: true };
    }

    case "RET":
    case "RETF": {
      if (m === "RETF") {
        const ip = this.pop16(); const cs = this.pop16();
        this.IP = ip; this.setSeg("CS", cs);
      } else {
        this.IP = this.pop16();
      }
      if (op1) this.r16[REG16.SP] = (this.r16[REG16.SP] + this.readOp(op1)) & MASK16;
      return { noAdvance: true };
    }

    case "IRET": {
      this.IP = this.pop16();
      this.setSeg("CS", this.pop16());
      this.setFlagsWord(this.pop16());
      return { noAdvance: true };
    }

    case "INT":
      r = this.doInterrupt(ir, this.readOp(op1));
      if (r && r.noAdvance) return r;
      break;
    case "INTO":
      if (this.getFlag("OF")) { r = this.doInterrupt(ir, 4); if (r && r.noAdvance) return r; }
      break;

    case "JCXZ":
      if (this.getReg("CX") === 0) { this.IP = op1.value & MASK16; return { noAdvance: true }; }
      break;

    case "LOOP": case "LOOPE": case "LOOPNE": case "LOOPZ": case "LOOPNZ": {
      const cx = (this.getReg("CX") - 1) & MASK16;
      this.setReg("CX", cx);
      let take = cx !== 0;
      if (m === "LOOPE" || m === "LOOPZ") take = take && this.getFlag("ZF") === 1;
      if (m === "LOOPNE" || m === "LOOPNZ") take = take && this.getFlag("ZF") === 0;
      if (take) { this.IP = op1.value & MASK16; return { noAdvance: true }; }
      break;
    }

    /* 条件跳转（含别名已在汇编器归一） */
    default: {
      if (COND[m]) {
        if (COND[m].call(this)) {
          this.IP = op1.value & MASK16;
          return { noAdvance: true, jumped: true };
        }
        break;
      }
      /* 标志/处理器控制 */
      switch (m) {
        case "CLC": this.setFlag("CF", 0); break;
        case "STC": this.setFlag("CF", 1); break;
        case "CMC": this.setFlag("CF", !this.getFlag("CF")); break;
        case "CLD": this.setFlag("DF", 0); break;
        case "STD": this.setFlag("DF", 1); break;
        case "CLI": this.setFlag("IF", 0); break;
        case "STI": this.setFlag("IF", 1); break;
        case "NOP": break;
        case "WAIT": break;
        case "HLT":
          this.halted = true; this.running = false;
          return { noAdvance: true, halt: true };
        case "IN":
          this.writeOp(op1, 0);     // 端口读，模拟返回 0
          break;
        case "OUT":
          break;                    // 端口写，忽略
        default:
          return { noAdvance: true, error: "指令尚未实现: " + m };
      }
    }
  }

  /* 正常顺序推进 */
  if (r && r.noAdvance) return r;
  this.IP = (this.IP + ir.size) & MASK16;
  return r;
};

/* ---------------- 中断与异常辅助 ---------------- */
CPU.prototype.doInterrupt = function (ir, n) {
  /* 模拟硬件中断栈帧：FLAGS, CS, 下一条IP */
  const next = (this.IP + ir.size) & MASK16;
  this.push16(this.getFlagsWord());
  this.push16(this.sreg[SREG.CS]);
  this.push16(next);

  let result = null;
  if (this.bus) result = this.bus.int(n, this);

  if (result === "WAIT") {
    this.waiting = true;
    return { noAdvance: true, wait: true };
  }
  if (result === "HALT") {
    this.halted = true;
    this.running = false;
    return { noAdvance: true, halt: true };
  }
  /* 正常中断返回：模拟 IRET 恢复栈帧 */
  this.pop16(); this.pop16(); this.pop16();
  return {};
};

/* 等待输入完成后由 app 调用：恢复栈帧并推进 IP */
CPU.prototype.completeIntWait = function () {
  this.pop16(); this.pop16(); this.pop16();
  this.IP = (this.IP + this.lastIR.size) & MASK16;
  this.waiting = false;
};

CPU.prototype.raiseDivError = function () {
  this.error = "除法错误";
  this.halted = true;
  this.running = false;
};
