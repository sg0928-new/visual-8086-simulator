/* ============================================================
   memory.js — 8086 1MB 分段内存模型
   物理地址 = (段寄存器 << 4) + 偏移，范围 00000h ~ FFFFFh
   小端序（Little-Endian）：低字节在低地址
   ============================================================ */

class Memory {
  constructor() {
    this.size = 0x100000;          // 1 MB
    this.buf = new Uint8Array(this.size);
  }

  reset() {
    this.buf.fill(0);
  }

  /* 段:偏移 -> 20 位物理地址 */
  static physical(seg, off) {
    return ((seg << 4) + off) & 0xFFFFF;
  }

  readByte(phys) {
    return this.buf[phys & 0xFFFFF];
  }

  writeByte(phys, val) {
    this.buf[phys & 0xFFFFF] = val & 0xFF;
  }

  /* 16 位字，小端读取 */
  readWord(phys) {
    const p = phys & 0xFFFFF;
    const lo = this.buf[p];
    const hi = this.buf[(p + 1) & 0xFFFFF];
    return (hi << 8) | lo;
  }

  writeWord(phys, val) {
    const p = phys & 0xFFFFF;
    this.buf[p] = val & 0xFF;
    this.buf[(p + 1) & 0xFFFFF] = (val >> 8) & 0xFF;
  }

  /* 批量写入（用于加载数据段） */
  writeBytes(phys, arr) {
    for (let i = 0; i < arr.length; i++) {
      this.buf[(phys + i) & 0xFFFFF] = arr[i] & 0xFF;
    }
  }

  /* 读取一段字节 */
  readBytes(phys, len) {
    const out = [];
    for (let i = 0; i < len; i++) out.push(this.buf[(phys + i) & 0xFFFFF]);
    return out;
  }
}

/* 全局常量：位掩码工具 */
const MASK8 = 0xFF;
const MASK16 = 0xFFFF;

function u8(v) { return v & 0xFF; }
function u16(v) { return v & 0xFFFF; }
function toSigned(v, bits) {
  const m = 1 << (bits - 1);
  return (v & (m - 1)) - (v & m);
}
function fromSigned(v, bits) {
  return v & ((1 << bits) - 1);
}
