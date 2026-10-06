@echo off
rem Start the server in the background now and every time Windows signs in
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\HOSxP XE Test Summary.lnk'); $s.TargetPath='wscript.exe'; $s.Arguments='\"%~dp0start-hidden.vbs\"'; $s.WorkingDirectory='%~dp0'; $s.Save()"
wscript.exe "%~dp0start-hidden.vbs"
echo Installed. The server now runs in the background at http://localhost:4001/
pause
