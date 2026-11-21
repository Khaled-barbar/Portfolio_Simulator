@echo off
REM Download the latest prices and publish the site (Kinsta redeploys it automatically).
REM Double-click to run now. scripts\schedule_windows.bat runs it every weekday evening.
cd /d "%~dp0.."
set PYTHONUTF8=1
if /i "%~1"=="/scheduled" goto scheduled
py -3 scripts\build_data.py --publish
echo.
pause
exit /b

:scheduled
if not exist logs mkdir logs
echo ==== %date% %time% ==== >> logs\publish.log
py -3 scripts\build_data.py --publish >> logs\publish.log 2>&1
