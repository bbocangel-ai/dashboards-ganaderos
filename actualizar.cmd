@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo ========================================
echo  ACTUALIZANDO DASHBOARDS GANADEROS
echo ========================================
echo.

echo [1/3] Sincronizando con SisGado...
call npm run sync
if errorlevel 1 (
  echo.
  echo ERROR en sync. Revisa que SisGado este corriendo.
  pause
  exit /b 1
)

echo.
echo [2/3] Verificando cambios...
git add -A
git diff --cached --quiet
if not errorlevel 1 (
  echo No hay cambios. Todo al dia.
  echo.
  pause
  exit /b 0
)

echo.
echo [3/3] Subiendo a GitHub...
git commit -m "sync: %date% %time%"
git push
if errorlevel 1 (
  echo.
  echo ERROR al hacer push. Revisa tu conexion / credenciales.
  pause
  exit /b 1
)

echo.
echo ========================================
echo  LISTO. El sitio se actualiza en ~1 min.
echo  https://bbocangel-ai.github.io/dashboards-ganaderos/
echo ========================================
echo.
timeout /t 5
