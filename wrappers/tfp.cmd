@echo off
REM ============================================================================
REM  tfp.cmd - runs tf.exe with a Personal Access Token (PAT), so Azure DevOps
REM            never asks you to sign in interactively.
REM
REM  Usage:   tfp <any tf command and its arguments>
REM    e.g.   tfp vc status /recursive
REM           tfp vc checkout Program.cs
REM           tfp vc workspaces /collection:https://dev.azure.com/your-org/
REM
REM  The PAT is read from a file, never stored here, so this script holds no
REM  secret and can be shared. Default: %USERPROFILE%\.tfs\pat.txt, the token
REM  on the first line, no BOM. Override the location with TFS_PAT_FILE.
REM
REM  TF.exe comes from Visual Studio. It is found through TF_EXE if that is
REM  set, otherwise through vswhere, preferring Visual Studio 2022 and
REM  otherwise the newest Visual Studio 2019 or later.
REM
REM  Create a PAT at https://dev.azure.com/your-org/_usersSettings/tokens
REM  with Full access (tf.exe's SOAP calls reject a Code-only token with
REM  TF30063). See docs/install/pat.md.
REM
REM  The Team Explorer (TFVC) VS Code extension, a terminal and an AI agent can
REM  all use this one file: it passes every argument through, appends the
REM  login arguments itself, prints nothing of its own on stdout, and returns
REM  tf's exit code.
REM ============================================================================
setlocal enabledelayedexpansion

set "PATFILE=%TFS_PAT_FILE%"
if "%PATFILE%"=="" set "PATFILE=%USERPROFILE%\.tfs\pat.txt"

if not exist "%PATFILE%" (
  echo [tfp] PAT file not found: %PATFILE% 1>&2
  echo [tfp] Create it with your Azure DevOps PAT as the only line, or set TFS_PAT_FILE. 1>&2
  exit /b 1
)

set "TFSPAT="
set /p TFSPAT=<"%PATFILE%"
if "!TFSPAT!"=="" (
  echo [tfp] PAT file is empty: %PATFILE% 1>&2
  exit /b 1
)

set "TF=%TF_EXE%"
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not defined TF if exist "%VSWHERE%" for /f "usebackq delims=" %%i in (`call "%VSWHERE%" -nologo -sort -products * -version "[17.0,18.0)" -find "Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer\TF.exe"`) do if not defined TF if exist "%%i" set "TF=%%i"
if not defined TF if exist "%VSWHERE%" for /f "usebackq delims=" %%i in (`call "%VSWHERE%" -nologo -sort -products * -find "Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer\TF.exe"`) do if not defined TF if exist "%%i" set "TF=%%i"

if not defined TF (
  echo [tfp] TF.exe not found: TF_EXE is not set, and vswhere found no Visual Studio with Team Explorer. 1>&2
  echo [tfp] Install Visual Studio with Team Explorer, or set TF_EXE to the full path of TF.exe. 1>&2
  exit /b 1
)
if not exist "!TF!" (
  echo [tfp] TF.exe not found at: !TF! 1>&2
  echo [tfp] Fix TF_EXE, or unset it to let vswhere find TF.exe. 1>&2
  exit /b 1
)

REM /noprompt turns an authentication failure into an error instead of a
REM sign-in window. /loginType:OAuth is what makes a PAT work with Visual
REM Studio's tf.exe against Azure DevOps Services.
"%TF%" %* /noprompt /loginType:OAuth /login:.,!TFSPAT!
set "ec=%ERRORLEVEL%"

endlocal & exit /b %ec%
