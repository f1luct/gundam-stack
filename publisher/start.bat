@echo off
rem gundam-publisher 启动脚本(可注册为计划任务:开机运行)
cd /d %~dp0
:loop
node publisher.js >> publisher.log 2>&1
echo [%date% %time%] publisher exited, restarting in 5s >> publisher.log
timeout /t 5 /nobreak > nul
goto loop
