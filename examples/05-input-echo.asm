; 键盘输入：读取一个字符并回显，再输出提示串
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
END START
