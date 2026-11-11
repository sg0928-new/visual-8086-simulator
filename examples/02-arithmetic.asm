; 算术运算：观察 AX 与标志位变化
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
END START
