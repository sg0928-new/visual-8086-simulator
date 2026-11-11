; 经典 Hello World —— INT 21h / 09h 字符串输出
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
END START
