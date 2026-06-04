@echo off
chcp 65001 >nul
echo.
echo ========================================
echo  CONFIGURAR AUTO-SYNC (cada 30 minutos)
echo ========================================
echo.
echo Esto registra una tarea en Windows que ejecuta
echo actualizar.cmd automaticamente cada 30 minutos,
echo en background, mientras estes logueado.
echo.
echo No vas a tener que correr actualizar.cmd a mano.
echo.

set "TASKNAME=Dashboards Ganaderos - Auto Sync"
set "SCRIPT=%~dp0actualizar.cmd"

choice /C SN /M "Continuar (S/N)"
if errorlevel 2 (
    echo Cancelado.
    pause
    exit /b 0
)

echo.
echo Registrando tarea programada...
schtasks /Create /TN "%TASKNAME%" /TR "\"%SCRIPT%\"" /SC MINUTE /MO 30 /F
if errorlevel 1 (
    echo.
    echo ERROR al registrar la tarea.
    pause
    exit /b 1
)

echo.
echo ========================================
echo  LISTO. Auto-sync configurado.
echo ========================================
echo.
echo La tarea se llama: %TASKNAME%
echo.
echo Para ver / modificar / eliminar:
echo   1. Abri "Programador de tareas" (taskschd.msc)
echo   2. Buscala en la lista
echo.
echo Para correr manual una vez ahora:
echo   schtasks /Run /TN "%TASKNAME%"
echo.
echo Para eliminar:
echo   schtasks /Delete /TN "%TASKNAME%" /F
echo.
pause
