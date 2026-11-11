; 循环结构：计算 1+2+...+10 = 55
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
END START
