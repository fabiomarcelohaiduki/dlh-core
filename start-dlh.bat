@echo off
title DLH-CORE - Servidor (nao feche esta janela)
cd /d "%~dp0"
echo ============================================
echo   DLH-CORE rodando em http://localhost:3000
echo   Deixe esta janela ABERTA enquanto usar.
echo   Para parar: feche esta janela.
echo ============================================
echo.
call npm run dev
echo.
echo Servidor parou. Pressione uma tecla para fechar.
pause >nul
