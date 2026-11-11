; INT 21h / 0Ah：读取一行字符串（回车结束）
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
END START
