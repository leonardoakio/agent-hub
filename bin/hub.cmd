@echo off
where node >nul 2>nul || (echo o hub precisa do Node.js 18 ou mais novo: instale em https://nodejs.org & exit /b 127)
node "%~dp0hub.js" %*
