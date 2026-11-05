@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem make-cfe.cmd - build a .cfe from an extension file dump in extensions\<name>
rem Usage: make-cfe.cmd <ExtensionName> [output.cfe]
rem   Default output: build\<ExtensionName>.cfe
rem A disposable empty file infobase is created in %%TEMP%%, the main
rem configuration files are loaded into it, the extension is created and filled
rem from files, .cfe is dumped, the temp base is always deleted.
rem No working infobase is touched. Keep this file ASCII-only: cmd reads batch
rem files in the OEM codepage, so literal Cyrillic here would be garbled
rem (CP866 trap); the extension name arrives via the Unicode command line.

rem --- repo root (script lives in .zcode\skills\make-cfe\scripts) ---
for %%i in ("%~dp0..\..\..\..") do set "REPO=%%~fi"

if "%~1"=="" (
  echo [make-cfe] ERROR: usage: make-cfe.cmd ^<ExtensionName^> [output.cfe]
  exit /b 1
)
set "EXTNAME=%~1"
if not exist "%REPO%\extensions\%EXTNAME%\Configuration.xml" (
  echo [make-cfe] ERROR: not found: extensions\%EXTNAME%\Configuration.xml
  exit /b 1
)

rem --- locate latest platform ---
set "V8EXE="
for /f "delims=" %%v in ('dir /b /ad /o-n "C:\Program Files\1cv8" 2^>nul') do (
  if not defined V8EXE if exist "C:\Program Files\1cv8\%%v\bin\1cv8.exe" set "V8EXE=C:\Program Files\1cv8\%%v\bin\1cv8.exe"
)
if not defined V8EXE (
  echo [make-cfe] ERROR: 1cv8.exe not found under "C:\Program Files\1cv8"
  exit /b 1
)
echo [make-cfe] Platform: %V8EXE%

rem --- clean stale temp bases from killed runs ---
for /d %%d in ("%TEMP%\1c-cfe-build-*") do rd /s /q "%%d" 2>nul

rem --- output path ---
set "OUT=%~2"
if not defined OUT set "OUT=build\%EXTNAME%.cfe"
set "ABS=0"
if "%OUT:~1,1%"==":" set "ABS=1"
if "%OUT:~0,2%"=="\\" set "ABS=1"
if "%ABS%"=="0" set "OUT=%REPO%\%OUT%"
if /i not "%OUT:~-4%"==".cfe" set "OUT=%OUT%.cfe"
for %%i in ("%OUT%") do set "OUTDIR=%%~dpi"
if not exist "%OUTDIR%" mkdir "%OUTDIR%"
echo [make-cfe] Extension: %EXTNAME%
echo [make-cfe] Output: %OUT%

rem --- disposable temp infobase ---
set "WORK=%TEMP%\1c-cfe-build-%RANDOM%%RANDOM%"
set "LOG1=%WORK%\main.log"
set "LOG2=%WORK%\create.log"
set "LOG3=%WORK%\extload.log"
set "LOG4=%WORK%\dump.log"
echo [make-cfe] Temp infobase: %WORK%
"%V8EXE%" CREATEINFOBASE File="%WORK%"
if errorlevel 1 goto :fail
if not exist "%WORK%\1Cv8.1CD" goto :fail

echo [make-cfe] Loading main configuration files...
"%V8EXE%" DESIGNER /F "%WORK%" /LoadConfigFromFiles "%REPO%" /Out "%LOG1%"
if errorlevel 1 goto :fail

echo [make-cfe] Creating extension %EXTNAME% (can take a few minutes)...
"%V8EXE%" DESIGNER /F "%WORK%" /CreateExtension -Extension "%EXTNAME%" /Out "%LOG2%"
if errorlevel 1 goto :fail

echo [make-cfe] Loading extension files...
"%V8EXE%" DESIGNER /F "%WORK%" /LoadConfigFromFiles "%REPO%\extensions\%EXTNAME%" -Extension "%EXTNAME%" /Out "%LOG3%"
if errorlevel 1 goto :fail

echo [make-cfe] Dumping .cfe...
"%V8EXE%" DESIGNER /F "%WORK%" /DumpCfg "%OUT%" -Extension "%EXTNAME%" /Out "%LOG4%"
if errorlevel 1 goto :fail
if not exist "%OUT%" goto :fail
for %%s in ("%OUT%") do set "SIZE=%%~zs"
if %SIZE% EQU 0 goto :fail

echo [make-cfe] OK: %OUT% (%SIZE% bytes)
set "RC=0"
goto :cleanup

:fail
set "EC=%errorlevel%"
set "RC=1"
echo [make-cfe] FAILED (exit code %EC%)
if exist "%LOG1%" (
  echo --- main.log ---
  type "%LOG1%"
)
if exist "%LOG2%" (
  echo --- create.log ---
  type "%LOG2%"
)
if exist "%LOG3%" (
  echo --- extload.log ---
  type "%LOG3%"
)
if exist "%LOG4%" (
  echo --- dump.log ---
  type "%LOG4%"
)

:cleanup
if exist "%WORK%" rd /s /q "%WORK%" 2>nul
exit /b %RC%
