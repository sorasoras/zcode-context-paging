@echo off
rem Start the zcode-context-paging proxy detached (survives this console).
rem Logs: %USERPROFILE%\..\..\git\zcode-context-paging\logs  |  State: state\
start "zcp" /min cmd /c "node B:\git\zcode-context-paging\bin\zcp.mjs serve"
