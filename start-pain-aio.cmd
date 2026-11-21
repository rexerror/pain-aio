@echo off
setlocal
title PAIN-AiO v1.7.4 - Standalone Local Edition
cd /d "%~dp0"

set "PHOMA_TEST_USER_DATA_DIR=%~dp0.pain-aio-data"
set "VEO3_FLOW_EXECUTION_MODE=api"
set "APP_SHOW_LOG_VIEWER_BUTTON=1"
set "GROK_SHOW_LOG_VIEWER_BUTTON=1"
set "GROK_SHOW_ACCOUNT_OPEN_BROWSER_BUTTON=1"

echo [PAIN-AiO] Launching standalone PAIN-AiO-App.exe ...
start "" "%~dp0PAIN-AiO-Runtime\PAIN-AiO-App.exe"
