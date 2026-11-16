@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 server.py %*
  goto :end
)

where python >nul 2>nul
if %errorlevel%==0 (
  python server.py %*
  goto :end
)

echo.
echo Cobalt needs Python 3.10 or newer, but Python was not found on PATH.
echo Install it from https://www.python.org/downloads/ and try again.
echo.
pause

:end
endlocal
