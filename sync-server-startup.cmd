@echo off
REM Este .cmd es para copiar en la carpeta Startup de Windows:
REM   Win + R  →  escribí:  shell:startup  →  Enter
REM   Pega este acceso directo ahí.
REM Con eso, el sync-server arranca solo cada vez que prendes la PC.

cd /d "%~dp0"
start "" /min cmd /c "node scripts\sync-server.mjs"
