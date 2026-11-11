/* ============================================================
   app.js — 主控：初始化、运行循环、面板刷新、事件编排
   ============================================================ */

/* ---------------- 内置示例程序 ---------------- */
const EXAMPLES = [
  {
    name: "1. Hello 字符串输出",
    code: `; 经典 Hello World —— INT 21h / 09h 字符串输出
DATA SEGMENT
    MSG DB 'Hello, 8086 World!', 0DH, 0AH, '$'
DATA ENDS

CODE SEGMENT
    ASSUME CS:CODE, DS:DATA
START:
    MOV AX, DATA
    MOV DS, AX
    LEA DX, MSG
    MOV AH, 09H          ; 功能号 09h：输出 '$' 结尾字符串
    INT 21H
    MOV AH, 4CH          ; 4Ch：程序退出
    INT 21H
CODE ENDS
END START`
  },
  {
    name: "2. 算术运算与标志位",
    code: `; 算术运算：观察 AX 与标志位变化
CODE SEGMENT
    ASSUME CS:CODE
START:
    MOV AX, 28H          ; AX = 0x28
    MOV BX, 15H          ; BX = 0x15
    ADD AX, BX           ; AX = 0x3D
    MOV CX, AX
    SUB CX, 10H          ; CX = 0x2D
    MOV DX, 07H
    MOV AX, 06H
    MUL DX               ; AX = 0x2A (42)
    MOV AX, 64H
    MOV BL, 0AH
    DIV BL               ; AL=10, AH=0
    MOV AH, 4CH
    INT 21H
CODE ENDS
END START`
  },
  {
    name: "3. 循环求和 1..10",
    code: `; 循环结构：计算 1+2+...+10 = 55
CODE SEGMENT
    ASSUME CS:CODE
START:
    XOR AX, AX           ; 累加器清零
    MOV CX, 10           ; 循环计数
    MOV BX, 1            ; 当前数字
SUM:
    ADD AX, BX
    INC BX
    LOOP SUM             ; CX--, 非零则跳转
    ; 结果在 AX = 0x37 (55)
    MOV AH, 4CH
    INT 21H
CODE ENDS
END START`
  },
  {
    name: "4. 冒泡排序",
    code: `; 冒泡排序：数组升序排列
DATA SEGMENT
    ARR DW 5, 2, 9, 1, 7, 3
    N   DW 6
DATA ENDS

CODE SEGMENT
    ASSUME CS:CODE, DS:DATA
START:
    MOV AX, DATA
    MOV DS, AX
OUTER:
    MOV CX, N
    DEC CX
    JCXZ DONE            ; CX=0 排序完成
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
DONE:
    MOV AH, 4CH
    INT 21H
CODE ENDS
END START`
  },
  {
    name: "5. 交互输入输出",
    code: `; 键盘输入：读取一个字符并回显，再输出提示串
DATA SEGMENT
    PROMPT DB 'Please press a key: $'
    YOU    DB 0DH, 0AH, 'You pressed: $'
DATA ENDS

CODE SEGMENT
    ASSUME CS:CODE, DS:DATA
START:
    MOV AX, DATA
    MOV DS, AX
    LEA DX, PROMPT
    MOV AH, 09H
    INT 21H
    MOV AH, 01H          ; 01h：带回显的字符输入（阻塞）
    INT 21H
    MOV BL, AL           ; 保存输入字符
    LEA DX, YOU
    MOV AH, 09H
    INT 21H
    MOV DL, BL
    MOV AH, 02H          ; 02h：字符输出
    INT 21H
    MOV AH, 4CH
    INT 21H
CODE ENDS
END START`
  },
  {
    name: "6. 行缓冲输入与字符串",
    code: `; INT 21h / 0Ah：读取一行字符串（回车结束）
DATA SEGMENT
    ASK DB 'Enter your name: $'
    BUF DB 20, ?, 20 DUP(?)
    HI  DB 0DH, 0AH, 'Hi, $'
DATA ENDS

CODE SEGMENT
    ASSUME CS:CODE, DS:DATA
START:
    MOV AX, DATA
    MOV DS, AX
    LEA DX, ASK
    MOV AH, 09H
    INT 21H
    LEA DX, BUF
    MOV AH, 0AH
    INT 21H
    LEA DX, HI
    MOV AH, 09H
    INT 21H
    ; 在输入串末尾写 '$' 以便用 09h 输出
    MOV BX, 0
    MOV BL, BUF+1        ; 实际字符数
    MOV BYTE PTR BUF[BX+2], '$'
    LEA DX, BUF+2
    MOV AH, 09H
    INT 21H
    MOV AH, 4CH
    INT 21H
CODE ENDS
END START`
  }
];

/* ---------------- 全局对象 ---------------- */
const mem = new Memory();
const cpu = new CPU(mem);
const bus = new DosBus();
cpu.bus = bus;

let editor;
let timer = null;
let resumeAfterInput = false;     // 连续运行遇输入，完成后自动续跑

/* 工具：十六进制格式化 */
const h4 = v => (v & 0xFFFF).toString(16).toUpperCase().padStart(4, "0");
const h2 = v => (v & 0xFF).toString(16).toUpperCase().padStart(2, "0");
const h5 = v => (v & 0xFFFFF).toString(16).toUpperCase().padStart(5, "0");

/* ============================================================
   初始化
   ============================================================ */
function init() {
  editor = new Editor(
    document.getElementById("editorInput"),
    document.getElementById("editorHighlight"),
    document.getElementById("editorGutter")
  );

  buildRegPanel();
  bindEvents();
  buildExampleSelect();
  editor.setText(EXAMPLES[0].code);
  refreshAll();
}

/* ---------------- 寄存器面板 ---------------- */
function buildRegPanel() {
  const grid = document.getElementById("regGrid");
  const gp = [
    { n: "AX", hi: "AH", lo: "AL" }, { n: "BX", hi: "BH", lo: "BL" },
    { n: "CX", hi: "CH", lo: "CL" }, { n: "DX", hi: "DH", lo: "DL" },
    { n: "SP" }, { n: "BP" }, { n: "SI" }, { n: "DI" }
  ];
  let html = "";
  for (const r of gp) {
    const bytes = r.hi
      ? `<span class="reg-bytes" data-hi="${r.hi}" data-lo="${r.lo}"></span>` : "";
    html += `<div class="reg-box" data-reg="${r.n}">
      <div class="reg-top"><span class="reg-name">${r.n}</span>${bytes}</div>
      <span class="reg-val">0000</span></div>`;
  }
  for (const s of ["DS", "ES", "SS", "CS"]) {
    html += `<div class="reg-box seg-reg" data-reg="${s}">
      <div class="reg-top"><span class="reg-name">${s}</span></div>
      <span class="reg-val">0000</span></div>`;
  }
  grid.innerHTML = html;
}

/* ============================================================
   面板刷新
   ============================================================ */
function refreshAll() {
  refreshRegs();
  refreshFlags();
  refreshStack();
  refreshMemory();
  refreshCRT();
  refreshDisasm();
  refreshStatus();
}

function refreshRegs() {
  const animate = document.getElementById("chkAnimate").checked;
  document.querySelectorAll(".reg-box").forEach(box => {
    const name = box.dataset.reg;
    const isSeg = box.classList.contains("seg-reg");
    const val = isSeg ? cpu.getSeg(name) : cpu.getReg(name);
    const valEl = box.querySelector(".reg-val");
    if (valEl.textContent !== h4(val)) {
      valEl.textContent = h4(val);
      if (animate) {
        box.classList.add("changed");
        setTimeout(() => box.classList.remove("changed"), 700);
      }
    }
    const bEl = box.querySelector(".reg-bytes");
    if (bEl) {
      bEl.textContent =
        `${bEl.dataset.hi}:${h2(cpu.getReg(bEl.dataset.hi))} ` +
        `${bEl.dataset.lo}:${h2(cpu.getReg(bEl.dataset.lo))}`;
    }
  });
}

function refreshFlags() {
  document.querySelectorAll(".flag-item").forEach(it => {
    const on = cpu.getFlag(it.dataset.flag);
    it.classList.toggle("on", on === 1);
    it.querySelector("em").textContent = on;
  });
}

function refreshStack() {
  const view = document.getElementById("stackView");
  document.getElementById("stackHint").textContent =
    `SS:SP = ${h4(cpu.getSeg("SS"))}:${h4(cpu.getReg("SP"))}`;
  const sp = cpu.getReg("SP");
  let html = "";
  for (let i = 0; i < 12; i++) {
    const off = (sp + i * 2) & MASK16;
    const v = cpu.mem.readWord(Memory.physical(cpu.getSeg("SS"), off));
    html += `<div class="stack-line${i === 0 ? " top" : ""}">
      <span class="s-addr">${h4(cpu.getSeg("SS"))}:${h4(off)}</span>
      <span>${h4(v)}</span></div>`;
  }
  view.innerHTML = html;
}

function refreshMemory() {
  const follow = document.getElementById("chkMemFollow").checked;
  const segSel = document.getElementById("memSegSel");
  const addrInput = document.getElementById("memAddrInput");
  let segVal, off;
  if (follow) {
    segVal = cpu.getSeg("CS"); off = cpu.IP;
    segSel.value = "CS"; addrInput.value = h4(off);
  } else {
    segVal = cpu.getSeg(segSel.value);
    off = parseInt(addrInput.value, 16) || 0;
  }
  off = off & 0xFFF0;
  const ipPhys = Memory.physical(cpu.getSeg("CS"), cpu.IP);
  let html = "";
  for (let row = 0; row < 10; row++) {
    const rowOff = (off + row * 16) & MASK16;
    const phys = Memory.physical(segVal, rowOff);
    const bytes = mem.readBytes(phys, 16);
    const hex = bytes.map((b, i) => {
      const hot = phys + i === ipPhys;
      return `<b class="${hot ? "hot" : ""}">${h2(b)}</b>`;
    }).join(" ");
    const ascii = bytes.map(b =>
      (b >= 32 && b < 127) ? String.fromCharCode(b) :
      '<span class="dot">·</span>').join("");
    html += `<div class="mem-row">
      <span class="m-addr">${h4(segVal)}:${h4(rowOff)}</span>
      <span class="m-hex">${hex}</span>
      <span class="m-ascii">${ascii}</span></div>`;
  }
  document.getElementById("memoryDump").innerHTML = html;
  const startP = Memory.physical(segVal, off);
  document.getElementById("memInfo").textContent =
    `物理地址 ${h5(startP)} ~ ${h5(startP + 159)}`;
}

function refreshCRT() {
  document.getElementById("crtContent").textContent = bus.getScreenText();
  const cursor = document.getElementById("crtCursor");
  const screen = document.getElementById("crtScreen");
  screen.classList.toggle("crt-input-mode", bus.inputMode !== null);
  if (cpu.running || bus.inputMode || !cpu.halted) {
    cursor.style.display = "block";
    cursor.style.top = `calc(14px + ${bus.cur.row} * 1.45em)`;
    cursor.style.left = `calc(16px + ${bus.cur.col} * 1ch)`;
  } else {
    cursor.style.display = "none";
  }
}

function refreshDisasm() {
  const view = document.getElementById("disasmView");
  const hint = document.getElementById("disasmHint");
  if (!cpu.program.length) {
    view.innerHTML = ""; hint.textContent = "未加载"; return;
  }
  const cur = cpu.currentIR();
  const idx = Math.max(0, cpu.program.indexOf(cur));
  const slice = cpu.program.slice(Math.max(0, idx - 3), idx + 6);
  hint.textContent = `${h4(cpu.getSeg("CS"))}:${h4(cpu.IP)}`;
  view.innerHTML = slice.map(ir =>
    `<div class="disasm-line${ir === cur ? " current" : ""}">
      <span class="d-addr">${h4(ir.segVal)}:${h4(ir.offset)}</span>
      <span class="d-text">${ir.raw}</span></div>`).join("");
}

function refreshStatus() {
  const state = document.getElementById("statusState");
  if (cpu.halted) { state.textContent = "● 已停机"; state.className = "halted"; }
  else if (cpu.waiting) { state.textContent = "● 等待输入"; state.className = "waiting"; }
  else if (cpu.running) { state.textContent = "● 运行中"; state.className = "running"; }
  else { state.textContent = "● 就绪"; state.className = ""; }

  document.getElementById("statusCSIP").textContent =
    `CS:IP = ${h4(cpu.getSeg("CS"))}:${h4(cpu.IP)}`;
  document.getElementById("statusPhys").textContent =
    `物理地址 = ${h5(Memory.physical(cpu.getSeg("CS"), cpu.IP))}`;
  document.getElementById("statusInstr").textContent =
    `指令数 = ${cpu.instrCount}`;
  document.getElementById("statusCycles").textContent =
    `周期 ≈ ${cpu.cycles}`;
}

/* ============================================================
   运行控制
   ============================================================ */

/* 速度：0..100 映射到每拍执行条数（拍长 50ms） */
function batchSize() {
  const v = parseInt(document.getElementById("speedRange").value, 10);
  const ips = Math.round(2 + Math.pow(v / 100, 2) * 4998);
  document.getElementById("speedText").textContent =
    ips >= 1000 ? (ips / 1000).toFixed(1) + "k 条/秒" : ips + " 条/秒";
  return Math.max(1, Math.round(ips / 20));
}

function assembleAndLoad() {
  pauseInternal();
  const res = new Assembler().assemble(editor.getText());
  clearLog();
  if (res.errors.length) {
    for (const e of res.errors)
      log("log-err", `第 ${e.line} 行：${e.msg}`);
    log("log-err", `汇编失败，共 ${res.errors.length} 个错误`);
    return;
  }
  mem.reset();
  bus.reset();
  for (const d of res.dataLoads) mem.writeBytes(d.phys, d.bytes);
  cpu.loadProgram(res.program, res.codeMap, res.init);
  syncBreakpoints();
  editor.setCurrentLine(cpu.currentIR() ? cpu.currentIR().line : 0);
  setButtonsLoaded();
  refreshAll();
  log("log-ok", "汇编成功，已加载到内存");
  for (const s of res.segments)
    log("log-info", `段 ${s.name}：基址 ${h4(s.base)}h，长度 ${s.size} 字节` +
      (s.isCode ? "（代码）" : ""));
  log("log-info", `符号 ${res.symbols.length} 个，指令 ${res.program.length} 条`);
}

function syncBreakpoints() {
  cpu.breakpoints.clear();
  for (const lineNo of editor.bpLines) {
    const ir = cpu.program.find(x => x.line === lineNo);
    if (ir) cpu.breakpoints.add(ir.segVal + ":" + ir.offset);
  }
}

function runLoop() {
  if (!cpu.running) return;
  const k = batchSize();
  let stop = false;
  for (let i = 0; i < k; i++) {
    const r = cpu.step();
    if (r.breakpoint) { pauseInternal(); log("log-warn", "命中断点"); stop = true; break; }
    if (r.halt) { haltInternal(); stop = true; break; }
    if (r.error) { errorInternal(r.error); stop = true; break; }
    if (cpu.waiting) { waitInternal(); stop = true; break; }
  }
  if (cpu.currentIR()) editor.setCurrentLine(cpu.currentIR().line);
  refreshAll();
  if (!stop) timer = setTimeout(runLoop, 50);
}

function runStart() {
  if (cpu.halted) return;
  cpu.running = true;
  setButtonsRunning();
  timer = setTimeout(runLoop, 30);
  refreshStatus();
}

function pauseInternal() {
  cpu.running = false;
  if (timer) { clearTimeout(timer); timer = null; }
  if (!cpu.halted && !cpu.waiting) setButtonsLoaded();
}

function haltInternal() {
  cpu.running = false; cpu.halted = true;
  if (timer) { clearTimeout(timer); timer = null; }
  setButtonsHalted();
  log("log-ok", "程序执行结束（INT 21h / 4Ch）");
}

function waitInternal() {
  cpu.running = false;
  if (timer) { clearTimeout(timer); timer = null; }
  resumeAfterInput = true;
  setButtonsWaiting();
}

function errorInternal(msg) {
  pauseInternal();
  cpu.halted = true;
  setButtonsHalted();
  log("log-err", msg);
}

function stepOnce() {
  if (cpu.halted || cpu.waiting) return;
  const r = cpu.step(true);          // 单步忽略断点
  if (r.error) { errorInternal(r.error); refreshAll(); return; }
  if (cpu.currentIR()) editor.setCurrentLine(cpu.currentIR().line);
  setButtonsLoaded();
  refreshAll();
}

function resetAll() {
  pauseInternal();
  mem.reset();
  bus.reset();
  cpu.reset();
  editor.setCurrentLine(0);
  refreshAll();
  setButtonsInitial();
  log("log-info", "系统已复位");
}

/* ---------------- 按钮状态 ---------------- */
function setButtons(loaded, running, halted, waiting) {
  document.getElementById("btnAssemble").disabled = running;
  document.getElementById("btnRun").disabled = !loaded || running || halted;
  document.getElementById("btnPause").disabled = !running;
  document.getElementById("btnStep").disabled = !loaded || running || halted || waiting;
}
const setButtonsInitial = () => setButtons(false, false, false, false);
const setButtonsLoaded = () => setButtons(true, false, false, false);
const setButtonsRunning = () => setButtons(true, true, false, false);
const setButtonsHalted = () => setButtons(true, false, true, false);
const setButtonsWaiting = () => setButtons(true, false, false, true);

/* ---------------- 日志 ---------------- */
function log(cls, msg) {
  const view = document.getElementById("logView");
  const div = document.createElement("div");
  div.className = "log-line " + cls;
  div.textContent = msg;
  view.appendChild(div);
  view.scrollTop = view.scrollHeight;
}
function clearLog() { document.getElementById("logView").innerHTML = ""; }

/* ============================================================
   事件绑定
   ============================================================ */
function bindEvents() {
  document.getElementById("btnAssemble").onclick = assembleAndLoad;
  document.getElementById("btnRun").onclick = runStart;
  document.getElementById("btnPause").onclick = () => { pauseInternal(); refreshStatus(); };
  document.getElementById("btnStep").onclick = stepOnce;
  document.getElementById("btnReset").onclick = resetAll;
  document.getElementById("btnClearLog").onclick = clearLog;
  document.getElementById("btnMemGo").onclick = () => {
    document.getElementById("chkMemFollow").checked = false;
    refreshMemory();
  };
  document.getElementById("speedRange").oninput = batchSize;

  /* 主题 */
  document.getElementById("themeSelect").onchange = e =>
    document.documentElement.dataset.theme = e.target.value;
  document.getElementById("chkCRT").onchange = e =>
    document.getElementById("crtScreen")
      .classList.toggle("no-scanlines", !e.target.checked);

  /* 等待状态回调 */
  bus.onWaitChange = (waiting) => {
    if (!waiting) {
      /* 输入完成：若之前是连续运行则自动续跑，否则保持就绪 */
      const shouldResume = resumeAfterInput;
      resumeAfterInput = false;
      if (cpu.currentIR()) editor.setCurrentLine(cpu.currentIR().line);
      refreshAll();
      if (shouldResume) runStart();
    }
  };

  /* 键盘：控制台输入 */
  const screen = document.getElementById("crtScreen");
  screen.tabIndex = 0;
  screen.addEventListener("keydown", e => {
    if (bus.inputMode) {
      e.preventDefault();
      bus.handleKey(e.key);
      refreshAll();
    }
  });

  /* 全局快捷键 */
  document.addEventListener("keydown", e => {
    if (e.key === "F5") { e.preventDefault(); assembleAndLoad(); }
    else if (e.key === "F6") { e.preventDefault(); if (!cpu.running) runStart(); }
    else if (e.key === "F7") { e.preventDefault(); stepOnce(); }
  });

  /* 模态框 */
  document.getElementById("btnHelp").onclick = showHelp;
  document.getElementById("btnAbout").onclick = showAbout;
  document.getElementById("modalClose").onclick = closeModal;
  document.getElementById("modalMask").onclick = e => {
    if (e.target.id === "modalMask") closeModal();
  };
}

function buildExampleSelect() {
  const sel = document.getElementById("exampleSelect");
  for (const ex of EXAMPLES) {
    const o = document.createElement("option");
    o.value = ex.name; o.textContent = ex.name;
    sel.appendChild(o);
  }
  sel.onchange = () => {
    const ex = EXAMPLES.find(x => x.name === sel.value);
    if (ex) {
      editor.setText(ex.code);
      setButtonsInitial();
    }
  };
}

/* ---------------- 模态框内容 ---------------- */
function openModal(title, bodyHtml) {
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalBody").innerHTML = bodyHtml;
  document.getElementById("modalMask").classList.add("show");
}
function closeModal() {
  document.getElementById("modalMask").classList.remove("show");
}

function showHelp() {
  openModal("使用说明", `
  <h3>快速开始</h3>
  <ul>
    <li>在左侧编辑器输入/粘贴汇编代码，或从右上角下拉选择内置示例。</li>
    <li>点击 <code>汇编加载</code>（F5）：汇编并加载到内存，错误会带行号显示在日志中。</li>
    <li><code>运行</code>（F6）连续执行；<code>单步</code>（F7）每次执行一条指令，便于观察。</li>
    <li>点击编辑器行号设置/取消断点；运行到断点自动暂停。</li>
  </ul>
  <h3>语法约定（MASM/TASM 风格）</h3>
  <ul>
    <li>注释以 <code>;</code> 开始；数字：<code>100</code> 十进制、<code>0FFh</code> 十六进制、<code>1010b</code> 二进制。</li>
    <li>支持完整段 <code>SEGMENT/ENDS</code> 与简化段 <code>.DATA/.CODE/.STACK</code>。</li>
    <li>数据定义 <code>DB/DW/DD</code>，支持 <code>DUP</code>、字符串、<code>EQU</code>、<code>ORG</code>、<code>OFFSET/SEG/PTR</code>。</li>
    <li>寻址：<code>[BX]</code>、<code>[BX+SI]</code>、<code>[BP+DI+10]</code>、<code>VAR[BX]</code>、<code>[1234h]</code>。</li>
  </ul>
  <h3>常用 DOS 中断</h3>
  <table>
    <tr><th>中断/功能</th><th>作用</th></tr>
    <tr><td>INT 21h / AH=09h</td><td>输出 DS:DX 处 '$' 结尾字符串</td></tr>
    <tr><td>INT 21h / AH=02h</td><td>输出 DL 中的字符</td></tr>
    <tr><td>INT 21h / AH=01h</td><td>带回显的字符输入（阻塞）</td></tr>
    <tr><td>INT 21h / AH=0Ah</td><td>行缓冲输入，回车结束</td></tr>
    <tr><td>INT 21h / AH=4Ch</td><td>程序退出</td></tr>
    <tr><td>INT 10h / AH=0Eh</td><td>电传方式输出字符</td></tr>
  </table>
  <h3>标志位</h3>
  <p>CF 进位 · PF 奇偶 · AF 辅助进位 · ZF 零 · SF 符号 · TF 陷阱 · IF 中断允许 · DF 方向 · OF 溢出</p>
  `);
}

function showAbout() {
  openModal("关于", `
  <h3>8086 Visual Simulator</h3>
  <p>面向微机原理课程的 8086 汇编可视化实验环境，参考 EMU8086、TASM、DOSBox 的交互理念。</p>
  <ul>
    <li>真实 1MB 分段内存模型（物理地址 = 段×16 + 偏移），小端序。</li>
    <li>完整通用/段寄存器与 9 个标志位，覆盖数据传送、算术、逻辑、移位、串操作、跳转、调用与中断。</li>
    <li>两遍汇编器支持 MASM/TASM 风格语法与前向引用。</li>
    <li>纯前端实现，无需联网；可通过 Electron 打包为 Windows 独立程序。</li>
  </ul>
  <p>所有核心逻辑附带自动化测试（<code>test/core-test.js</code>，25 项断言）。</p>
  `);
}

/* 启动 */
window.addEventListener("DOMContentLoaded", init);
