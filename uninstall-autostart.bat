@echo off
rem Stop the background server and remove it from Windows startup
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\HOSxP XE Test Summary.lnk" 2>nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*server.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo Removed. The server is stopped and will not start with Windows.
pause
