# Visual 8086 Simulator

[简体中文](README.md) | **English**

A visual lab environment for **Microcomputer Principles / Assembly Language** courses. It closes the full loop in a single interface — *edit code → assemble → run / step → inspect registers, flags, memory, stack and DOS I/O* — re-imagining the workflow of EMU8086, TASM and DOSBox with modern visualization.

Built with pure front-end technologies: **no network access and no runtime libraries required**. A standalone Windows application packaged with Electron is also provided.

---

## 1. Features

- **Two-pass assembler (MASM/TASM style)**
  - Full segments `SEGMENT / ENDS / ASSUME / END` and simplified segments `.DATA / .CODE / .STACK`
  - Directives `DB / DW / DD / DUP / EQU / = / ORG / OFFSET / SEG / PTR / $`
  - Forward label references, expression evaluation (`+ - * / MOD & | XOR`), strings and character constants
  - Errors are pinpointed with the **source line number** and listed in the log panel
- **Interpreted 8086 instruction set**
  - Data transfer, arithmetic (including multiply/divide and BCD adjustment), logic, shift/rotate, string operations (`REP/REPE/REPNE`)
  - Control transfer: unconditional/conditional jumps, the `LOOP` family, `CALL / RET / RETF / INT / IRET`
- **Faithful hardware model**
  - 1 MB memory; physical address = segment×16 + offset, **little-endian**
  - 8 general-purpose registers (with 8-bit split AH/AL…), 4 segment registers, 9 flags
  - A dedicated stack segment with real pushes for `PUSH / POP / CALL / INT`; a live stack view
- **DOS-like console**
  - 80×25 character screen with CRT phosphor glow and scanlines; supports CR/LF/backspace/tab
  - `INT 21h` character/string/line-buffered I/O with a **blocking keyboard input** state machine
- **Full visualization**
  - Current-line highlight, breakpoints (click the line number), register-change flashing, flag LEDs, Hex+ASCII memory dump
  - Disassembly view, speed slider, three color schemes (phosphor green / amber / ice blue)

---

## 2. Quick Start (3 options)

### Option 1: Open in a browser (zero dependencies, recommended)

Double-click **`启动模拟器.bat`** in the project root, or simply double-click **`index.html`**. It runs in your default browser with nothing to install.

### Option 2: Electron desktop window (development mode)

Requires [Node.js](https://nodejs.org).

```powershell
npm install
npm start
```

### Option 3: Build a standalone Windows exe

```powershell
npm run dist
```

The output is `dist\8086汇编可视化模拟器.exe`, a single portable file that can be copied to and run on any Windows PC.

---

## 3. How to Use (Tutorial)

1. **Load code**: pick a program from the “内置示例” (built-in examples) drop-down at the top right, or write/paste assembly directly in the editor on the left.
2. **Assemble**: click “汇编加载” on the toolbar (or press `F5`). On success, the log panel shows the segment table and symbols, and the current line is highlighted. Syntax errors are listed here with the line number and reason.
3. **Run or step**:
   - “运行” (`F6`): runs continuously; adjust the speed slider, and use “暂停” (pause) to stop at any time.
   - “单步” (`F7`): executes one instruction at a time for close inspection.
4. **Set breakpoints**: click a line number in the editor gutter; a red dot marks a breakpoint, click again to remove it. Execution pauses automatically when it reaches a breakpoint.
5. **Keyboard input**: when the program reaches an input instruction (e.g. `INT 21h / AH=01h`), the status bar shows “等待输入” (waiting for input). Click the CRT screen in the middle to focus it, then press a key; the program resumes automatically afterward.
6. **Inspect state**: registers and flags on the right, memory at the bottom, and the stack view shows stack contents. “复位” (reset) clears everything back to the initial state.

---

## 4. Interface & Controls

| Area | Description |
|---|---|
| Source editor | Left; line numbers + syntax highlighting; click line numbers to toggle breakpoints; Tab to indent |
| DOS console | Center CRT screen for program output and keyboard input; click it before typing when waiting |
| Registers | Right; 16-bit values with 8-bit split (AH/AL), highlighted on change |
| Flags | 9 LEDs: CF PF AF ZF SF TF IF DF OF |
| Stack | Word by word from SS:SP, with the top highlighted |
| Memory viewer | Bottom; choose DS/SS/ES/CS and offset, Hex + ASCII, can follow IP |
| Disassembly | Below the console; instructions near the current CS:IP |

**Shortcuts**: `F5` assemble · `F6` run · `F7` step

---

## 5. Supported DOS / BIOS Interrupts

| Interrupt | Function | Purpose |
|---|---|---|
| INT 21h | AH=09h | Print the `$`-terminated string at DS:DX |
| INT 21h | AH=02h | Output the character in DL |
| INT 21h | AH=01h | Echoed character input (blocking) |
| INT 21h | AH=07h/08h | Character input without echo |
| INT 21h | AH=0Ah | Buffered line input, ended by Enter |
| INT 21h | AH=4Ch / 00h | Terminate the program |
| INT 10h | AH=0Eh | Teletype character output |
| INT 16h | AH=00h | Keyboard character input |
| INT 20h | — | Program termination |

Number formats: `100` decimal · `0FFh` hexadecimal · `1010b` binary · `'A'` character constant.

---

## 6. Project Structure

```
8086asm/
├── index.html              # Main UI
├── css/style.css           # Retro CRT theme (three color schemes)
├── js/
│   ├── memory.js           # 1MB segmented memory model
│   ├── cpu.js              # CPU core: registers/flags/addressing/stack
│   ├── instructions.js     # Instruction-set interpreter
│   ├── assembler.js        # Two-pass assembler
│   ├── dos.js              # DOS/BIOS interrupts and screen model
│   ├── editor.js           # Code editor
│   └── app.js              # Controller: run loop and UI orchestration
├── examples/               # 6 sample assembly programs
├── test/core-test.js       # Automated core tests (25 assertions)
├── electron-main.js        # Electron main process
├── package.json
└── 启动模拟器.bat
```

---

## 7. Running the Tests

```powershell
node test/core-test.js
```

Covers assembly, addressing, arithmetic/flags, multiply/divide, loops, memory variables, strings, CALL/RET, shifts, conditional jumps, buffered input, bubble sort and block copy across 25 assertions. All must pass before release.

---

## 8. Architecture Notes

- The first assembler pass builds the segment table and symbol offsets; the second pass generates an internal representation (IR) and loads data. Segment addresses are allocated automatically on 16-byte alignment (starting at `1000h`).
- Code is executed as IR indexed by CS:IP, with IP advancing by instruction byte length. Data, stack and variable addressing all go through real memory reads/writes and segment:offset physical addresses.
- Blocking input is implemented with an asynchronous state machine: the CPU suspends → the console receives keystrokes → values are written back to registers/buffers → execution resumes. Input encountered during a continuous run auto-resumes once completed.
