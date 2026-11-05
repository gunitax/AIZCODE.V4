@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem make-cf.cmd - build a .cf from the file-based configuration dump in this repo
rem Usage: make-cf.cmd [output.cf]
rem   No argument: name taken from .specify\feature.json (feature_directory),
rem   result written to build\<feature>.cf
rem A disposable empty file infobase is created in %%TEMP%%, configuration files
rem are loaded into it, .cf is dumped, the temp base is always deleted.

rem --- repo root (script lives in .zcode\skills\make-cf\scripts) ---
for %%i in ("%~dp0..\..\..\..") do set "REPO=%%~fi"

rem --- locate latest platform ---
set "V8EXE="
for /f "delims=" %%v in ('dir /b /ad /o-n "C:\Program Files\1cv8" 2^>nul') do (
  if not defined V8EXE if exist "C:\Program Files\1cv8\%%v\bin\1cv8.exe" set "V8EXE=C:\Program Files\1cv8\%%v\bin\1cv8.exe"
)
if not defined V8EXE (
  echo [make-cf] ERROR: 1cv8.exe not found under "C:\Program Files\1cv8"
  exit /b 1
)
echo [make-cf] Platform: %V8EXE%

rem --- clean stale temp bases from killed runs ---
for /d %%d in ("%TEMP%\1c-cf-build-*") do rd /s /q "%%d" 2>nul

rem --- output path ---
set "OUT=%~1"
if not defined OUT (
  if not exist "%REPO%\.specify\feature.json" (
    echo [make-cf] ERROR: no output path given and .specify\feature.json not found
    exit /b 1
  )
  for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(ConvertFrom-Json (Get-Content -Raw -LiteralPath '%REPO%\.specify\feature.json')).feature_directory"`) do set "FD=%%i"
  if not defined FD (
    echo [make-cf] ERROR: feature_directory not found in feature.json
    exit /b 1
  )
  for %%i in ("!FD!") do set "OUT=%REPO%\build\%%~nxi.cf"
)
set "ABS=0"
if "%OUT:~1,1%"==":" set "ABS=1"
if "%OUT:~0,2%"=="\\" set "ABS=1"
if "%ABS%"=="0" set "OUT=%REPO%\%OUT%"
if /i not "%OUT:~-3%"==".cf" set "OUT=%OUT%.cf"
for %%i in ("%OUT%") do set "OUTDIR=%%~dpi"
if not exist "%OUTDIR%" mkdir "%OUTDIR%"
echo [make-cf] Output: %OUT%

rem --- disposable temp infobase ---
set "WORK=%TEMP%\1c-cf-build-%RANDOM%%RANDOM%"
set "LOG1=%WORK%\load.log"
set "LOG2=%WORK%\dump.log"
echo [make-cf] Temp infobase: %WORK%
"%V8EXE%" CREATEINFOBASE File="%WORK%"
if errorlevel 1 goto :fail
if not exist "%WORK%\1Cv8.1CD" goto :fail

echo [make-cf] Loading configuration files (about 7 minutes)...
"%V8EXE%" DESIGNER /F "%WORK%" /LoadConfigFromFiles "%REPO%" /Out "%LOG1%"
if errorlevel 1 goto :fail

echo [make-cf] Dumping .cf...
"%V8EXE%" DESIGNER /F "%WORK%" /DumpCfg "%OUT%" /Out "%LOG2%"
if errorlevel 1 goto :fail
if not exist "%OUT%" goto :fail
for %%s in ("%OUT%") do set "SIZE=%%~zs"
if %SIZE% EQU 0 goto :fail

echo [make-cf] OK: %OUT% (%SIZE% bytes)
goto :cleanup

:fail
set "EC=%errorlevel%"
set "RC=1"
echo [make-cf] FAILED (exit code %EC%)
if exist "%LOG1%" (
  echo --- load.log ---
  type "%LOG1%"
)
if exist "%LOG2%" (
  echo --- dump.log ---
  type "%LOG2%"
)

:cleanup
if exist "%WORK%" rd /s /q "%WORK%" 2>nul
if "%RC%"=="1" exit /b 1
exit /b 0
