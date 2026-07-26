@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Sync Server - Dashboards Ganaderos
echo.
echo  Iniciando servidor local de sync...
echo  Deja esta ventana abierta.
echo.
node scripts\sync-server.mjs
if errorlevel 1 (
  echo.
  echo Server termino con error. Presiona una tecla para cerrar.
  pause >nul
)
