@echo off
rem Homebase native messaging host "com.homebase.launcher" for Chrome and Edge.
rem Source: native-host\launcher.cmd in the Homebase repository. scripts\install-autostart.ps1
rem copies it to LOCALAPPDATA\Homebase\native-host and fills in the absolute node.exe path.
rem The browser runs it with "cmd.exe /d /s /c" and a hidden console. Stdin and stdout carry the
rem messages, so nothing else may print here, and nothing may be launched with "start":
rem launcher.mjs asks Task Scheduler to start the server instead.
"{{NODE_EXE}}" "%~dp0launcher.mjs" %*
