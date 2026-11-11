/* ============================================================
   core-test.js — 核心逻辑端到端测试（Node 环境，无需浏览器）
   运行: node test/core-test.js
   ============================================================ */
const path = require("path");
const fs = require("fs");
const vm = require("vm");

/* 在同一 VM 上下文加载浏览器端脚本，再导出类 */
const root = path.join(__dirname, "..");
const ctx = { console, process };
vm.createContext(ctx);
for (const f of ["js/memory.js", "js/cpu.js", "js/instructions.js", "js/assembler.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), ctx, { filename: f });
}
vm.runInContext("globalThis.__C = { Memory, CPU, Assembler };", ctx);
const { Memory, CPU, Assembler } = ctx.__C;

/* Mock 中断总线：捕获输出，输入用预置队列 */
class MockBus {
  constructor(inputQueue = []) {
    this.out = "";
    this.input = inputQueue;
  }
  int(n, cpu) {
    if (n === 0x21) {
      const ah = cpu.getReg("AH");
      if (ah === 0x4C || ah === 0x00) return "HALT";
      if (ah === 0x02 || ah === 0x06) {
        this.out += String.fromCharCode(cpu.getReg("DL"));
        return;
      }
      if (ah === 0x09) {
        let p = Memory.physical(cpu.getSeg("DS"), cpu.getReg("DX"));
        while (cpu.mem.readByte(p) !== 0x24) {
          this.out += String.fromCharCode(cpu.mem.readByte(p));
          p = (p + 1) & 0xFFFFF;
        }
        return;
      }
      if (ah === 0x01 || ah === 0x07 || ah === 0x08) {
        const ch = this.input.shift();
        cpu.setReg("AL", ch === undefined ? 0 : ch);
        if (ah === 0x01) this.out += String.fromCharCode(ch || 0);
        return;
      }
      if (ah === 0x0A) {
        const { phys } = { phys: Memory.physical(cpu.getSeg("DS"), cpu.getReg("DX")) };
        const max = cpu.mem.readByte(phys);
        const buf = this.input;
        let i = 0;
        for (; i < buf.length && i < max - 1; i++) cpu.mem.writeByte(phys + 2 + i, buf[i]);
        cpu.mem.writeByte(phys + 1, i);
        return;
      }
    }
    if (n === 0x20) return "HALT";
    if (n === 0x10) {
      const ah = cpu.getReg("AH");
      if (ah === 0x0E) { this.out += String.fromCharCode(cpu.getReg("AL")); return; }
    }
    if (n === 0x16) {
      const ch = this.input.shift();
      cpu.setReg("AL", ch === undefined ? 0 : ch);
      return;
    }
  }
}

/* 运行一个程序至停机 */
function runProgram(src, input) {
  const mem = new Memory();
  const cpu = new CPU(mem);
  const bus = new MockBus(input || []);
  cpu.bus = bus;
  const asm = new Assembler();
  const res = asm.assemble(src);
  if (res.errors.length) return { errors: res.errors, cpu, bus, res };
  for (const d of res.dataLoads) mem.writeBytes(d.phys, d.bytes);
  cpu.loadProgram(res.program, res.codeMap, res.init);
  let guard = 0;
  while (!cpu.halted && guard < 100000) {
    const r = cpu.step();
    if (r && r.error) return { error: r.error, cpu, bus };
    guard++;
  }
  return { cpu, bus, res, guard };
}

/* ---------------- 断言框架 ---------------- */
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  [PASS] " + name); }
  else { fail++; console.log("  [FAIL] " + name + (detail ? " -> " + detail : "")); }
}
function hex(v) { return (v & 0xFFFF).toString(16).toUpperCase().padStart(4, "0"); }

console.log("\n== 1. 立即数与加减 ==");
{
  const r = runProgram(`
    CODE SEGMENT
    ASSUME CS:CODE
    MOV AX, 5
    ADD AX, 3
    MOV BX, AX
    SUB BX, 2
    MOV AH, 4CH
    INT 21H
    CODE ENDS
    END`);
  check("无汇编错误", !r.errors && !r.error, JSON.stringify(r.errors || r.error));
  check("AX = 8", r.cpu && r.cpu.getReg("AL") === 8, hex(r.cpu && r.cpu.getReg("AX")));
  check("BX = 6", r.cpu && r.cpu.getReg("BX") === 6, hex(r.cpu && r.cpu.getReg("BX")));
}

console.log("\n== 2. 标志位 ZF/CF/SF ==");
{
  const r1 = runProgram(`
    CODE SEGMENT
    MOV AX, 5
    SUB AX, 5
    MOV AH, 4CH
    INT 21H
    CODE ENDS
    END`);
  check("SUB 后 ZF=1", r1.cpu.getFlag("ZF") === 1);

  const r2 = runProgram(`
    CODE SEGMENT
    MOV BX, 3
    CMP BX, 8
    MOV AH, 4CH
    INT 21H
    CODE ENDS
    END`);
  check("CMP 3,8 后 CF=1(借位)", r2.cpu.getFlag("CF") === 1);
  check("CMP 后 SF=1", r2.cpu.getFlag("SF") === 1);
}

console.log("\n== 3. 乘法 ==");
{
  const r = runProgram(`
    CODE SEGMENT
    MOV AL, 6
    MOV BL, 7
    MUL BL
    MOV AH, 4CH
    INT 21H
    CODE ENDS
    END`);
  check("6*7 = 42 (002Ah)", r.cpu.getReg("AL") === 42, hex(r.cpu.getReg("AX")));
}

console.log("\n== 4. 循环求和 1..10 = 55 ==");
{
  const r = runProgram(`
    CODE SEGMENT
    XOR AX, AX
    MOV CX, 10
    MOV BX, 1
    S:
    ADD AX, BX
    INC BX
    LOOP S
    MOV AH, 4CH
    INT 21H
    CODE ENDS
    END`);
  check("1..10 = 55", r.cpu.getReg("AL") === 55, hex(r.cpu.getReg("AX")));
}

console.log("\n== 5. 数据段内存变量 ==");
{
  const r = runProgram(`
    DATA SEGMENT
    NUM DW 100
    RES DW ?
    DATA ENDS
    CODE SEGMENT
    ASSUME CS:CODE, DS:DATA
    MOV AX, DATA
    MOV DS, AX
    MOV AX, NUM
    ADD AX, 25
    MOV RES, AX
    MOV AH, 4CH
    INT 21H
    CODE ENDS
    END`);
  check("无错误", !r.errors && !r.error, JSON.stringify(r.errors || r.error));
  check("RES = 125", r.cpu && r.cpu.getReg("AL") === 125, hex(r.cpu && r.cpu.getReg("AX")));
  /* 验证内存中 RES 位置 */
  const resSym = r.res.symbols.find(s => s.name === "RES");
  const phys = Memory.physical(r.res.init.DS, resSym.off);
  check("内存 RES 字 = 125", r.cpu.mem.readWord(phys) === 125);
}

console.log("\n== 6. 字符串输出 INT21/09h ==");
{
  const r = runProgram(`
    DATA SEGMENT
    MSG DB 'Hello, 8086!$'
    DATA ENDS
    CODE SEGMENT
    ASSUME CS:CODE, DS:DATA
    MOV AX, DATA
    MOV DS, AX
    LEA DX, MSG
    MOV AH, 9
    INT 21H
    MOV AH, 4CH
    INT 21H
    CODE ENDS
    END`);
  check("输出正确", r.bus.out === "Hello, 8086!", JSON.stringify(r.bus.out));
}

console.log("\n== 7. CALL/RET 与栈 ==");
{
  const r = runProgram(`
    CODE SEGMENT
    MOV AX, 10
    CALL DOUBLE
    MOV BX, AX
    MOV AH, 4CH
    INT 21H
    DOUBLE:
    ADD AX, AX
    RET
    CODE ENDS
    END`);
  check("RET 后 BX = 20", r.cpu.getReg("BX") === 20, hex(r.cpu.getReg("BX")));
}

console.log("\n== 8. 移位指令 ==");
{
  const r = runProgram(`
    CODE SEGMENT
    MOV AX, 1
    MOV CL, 4
    SHL AX, CL
    MOV BX, 240
    SHR BX, 1
    MOV AH, 4CH
    INT 21H
    CODE ENDS
    END`);
  check("1 << 4 = 16", r.cpu.getReg("AL") === 16, hex(r.cpu.getReg("AX")));
  check("240 >> 1 = 120", r.cpu.getReg("BX") === 120, hex(r.cpu.getReg("BX")));
}

console.log("\n== 9. 除法 ==");
{
  const r = runProgram(`
    CODE SEGMENT
    MOV AX, 100
    MOV BL, 7
    DIV BL
    CODE ENDS
    END`);
  check("100/7 商=14", r.cpu.getReg("AL") === 14);
  check("余数=2", r.cpu.getReg("AH") === 2);
}

console.log("\n== 10. 条件跳转 ==");
{
  const r = runProgram(`
    CODE SEGMENT
    MOV AX, 4
    CMP AX, 4
    JZ EQL
    MOV BX, 1
    JMP DONE
    EQL:
    MOV BX, 2
    DONE:
    MOV AH, 4CH
    INT 21H
    CODE ENDS
    END`);
  check("相等分支 BX=2", r.cpu.getReg("BX") === 2, hex(r.cpu.getReg("BX")));
}

console.log("\n== 11. 简化段 .DATA/.CODE ==");
{
  const r = runProgram(`
    .DATA
    VAL DW 50
    .CODE
    MOV AX, @DATA
    MOV DS, AX
    MOV AX, VAL
    INC AX
    MOV AH, 4CH
    INT 21H
    END`);
  check("简化段汇编通过", !r.errors && !r.error, JSON.stringify(r.errors || r.error));
  check("AX=51", r.cpu && r.cpu.getReg("AL") === 51, hex(r.cpu && r.cpu.getReg("AX")));
}

console.log("\n== 12. 缓冲输入 INT21/0Ah ==");
{
  const input = "abc".split("").map(c => c.charCodeAt(0));
  const r = runProgram(`
    DATA SEGMENT
    BUF DB 20, ?, 20 DUP(?)
    DATA ENDS
    CODE SEGMENT
    ASSUME CS:CODE, DS:DATA
    MOV AX, DATA
    MOV DS, AX
    LEA DX, BUF
    MOV AH, 0AH
    INT 21H
    MOV AH, 4CH
    INT 21H
    CODE ENDS
    END`, input);
  const bufSym = r.res.symbols.find(s => s.name === "BUF");
  const phys = Memory.physical(r.res.init.DS, bufSym.off);
  check("输入计数=3", r.cpu.mem.readByte(phys + 1) === 3);
  check("首字符=a", r.cpu.mem.readByte(phys + 2) === 97);
}

console.log("\n== 13. 冒泡排序（数组） ==");
{
  const r = runProgram(`
    DATA SEGMENT
    ARR DW 5, 2, 9, 1, 7
    N DW 5
    DATA ENDS
    CODE SEGMENT
    ASSUME CS:CODE, DS:DATA
    MOV AX, DATA
    MOV DS, AX
    OUTER:
    MOV CX, N
    DEC CX
    JCXZ ALLDONE
    XOR BX, BX
    INNER:
    MOV AX, ARR[BX]
    CMP AX, ARR[BX+2]
    JLE NOX
    XCHG AX, ARR[BX+2]
    MOV ARR[BX], AX
    NOX:
    ADD BX, 2
    LOOP INNER
    DEC N
    JNZ OUTER
    ALLDONE:
    MOV AH, 4CH
    INT 21H
    CODE ENDS
    END`);
  check("排序无错误", !r.errors && !r.error, JSON.stringify(r.errors || r.error));
  const arrSym = r.res.symbols.find(s => s.name === "ARR");
  const base = Memory.physical(r.res.init.DS, arrSym.off);
  const sorted = [0,2,4,6,8].map(o => r.cpu.mem.readWord(base + o));
  check("结果 1,2,5,7,9", JSON.stringify(sorted) === "[1,2,5,7,9]", JSON.stringify(sorted));
}

console.log("\n== 14. REP MOVSB 块复制 ==");
{
  const r = runProgram(`
    DATA SEGMENT
    SRC DB 1,2,3,4,5
    DST DB 5 DUP(0)
    DATA ENDS
    CODE SEGMENT
    ASSUME CS:CODE, DS:DATA, ES:DATA
    MOV AX, DATA
    MOV DS, AX
    MOV ES, AX
    LEA SI, SRC
    LEA DI, DST
    MOV CX, 5
    REP MOVSB
    MOV AH, 4CH
    INT 21H
    CODE ENDS
    END`);
  const dstSym = r.res.symbols.find(s => s.name === "DST");
  const p = Memory.physical(r.res.init.DS, dstSym.off);
  const got = r.cpu.mem.readBytes(p, 5);
  check("复制正确", JSON.stringify(got) === "[1,2,3,4,5]", JSON.stringify(got));
}

console.log("\n========================================");
console.log("测试结果: " + pass + " 通过, " + fail + " 失败");
console.log("========================================\n");
process.exit(fail ? 1 : 0);
