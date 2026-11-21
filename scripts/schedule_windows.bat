@echo off
REM Creates a Windows scheduled task that publishes prices every weekday at 18:45
REM (runs later if the computer was off at that time). Run it once; run again to update it.
set "S=%~dp0publish_prices.bat"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$a = New-ScheduledTaskAction -Execute '%S%' -Argument '/scheduled';" ^
  "$t = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 18:45;" ^
  "$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1);" ^
  "Register-ScheduledTask -TaskName 'Portfolio Simulator - publish prices' -Action $a -Trigger $t -Settings $s -Force | Out-Null;" ^
  "Write-Host 'Scheduled: every weekday at 18:45 (log: logs\publish.log)'"
pause
