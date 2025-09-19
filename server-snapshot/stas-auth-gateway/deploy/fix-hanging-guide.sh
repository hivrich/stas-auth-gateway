#!/bin/bash
# ПОЛНОЕ РУКОВОДСТВО: Решение проблемы зависания в Windsurf IDE

echo "🔧 РЕШЕНИЕ ПРОБЛЕМЫ ЗАВИСАНИЯ В WINDSURF IDE"
echo "=============================================="
echo ""

echo "ПРОБЛЕМА:"
echo "- Команды SSH, curl, scp зависают в IDE"
echo "- Локальные команды (ls, cd, echo) работают"
echo "- Сетевые команды работают в Terminal.app"
echo ""

echo "ПРИЧИНА:"
echo "- Конфликты в bash/zsh профилях"
echo "- Некорректные настройки PATH или shell"
echo "- IDE использует изолированную среду"
echo ""

echo "РЕШЕНИЕ (выполнить по шагам):"
echo ""

echo "ШАГ 1: Очистка bash/zsh профилей"
echo "-------------------------------"
/bin/bash --noprofile --norc -c '
ts=$(date +%s)
echo "Создаю backup профилей..."
for f in ~/.bash_profile ~/.bash_login ~/.profile ~/.bashrc ~/.zshrc ~/.zprofile ~/.zlogin; do
  [ -f "$f" ] && mv "$f" "$f.bak.$ts" && echo "Backup: $f.bak.$ts"
done

echo "Создаю чистые профили..."
cat > ~/.bashrc <<'\''RC'\''
export PATH="$HOME/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export SHELL=/bin/bash
RC

cat > ~/.bash_profile <<'\''PF'\''
[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"
PF

echo "✅ Профили очищены"
'

echo ""
echo "ШАГ 2: Перезапуск IDE"
echo "---------------------"
echo "1. Полностью закрой Windsurf IDE"
echo "2. Подожди 10 секунд"
echo "3. Запусти Windsurf заново"
echo "4. Открой новый терминал в IDE"
echo ""

echo "ШАГ 3: Проверка исправления"
echo "---------------------------"
echo "В новом терминале IDE выполни:"
echo ""
echo "# Тест 1: Локальные команды"
echo "date && pwd && whoami"
echo ""
echo "# Тест 2: SSH команды"
echo "ssh -i ~/.ssh/id_ed25519_new -o StrictHostKeyChecking=no root@109.172.46.200 'echo SSH_OK'"
echo ""
echo "# Тест 3: SCP команды"
echo "scp -i ~/.ssh/id_ed25519_new -o StrictHostKeyChecking=no deploy/test-endpoints.sh root@109.172.46.200:/tmp/"
echo ""

echo "ШАГ 4: Если всё ещё зависает"
echo "----------------------------"
echo "1. Проверь SSH ключи:"
echo "   ls -la ~/.ssh/"
echo "   ssh-add -l"
echo ""
echo "2. Проверь переменные:"
echo "   echo \$PATH"
echo "   echo \$SHELL"
echo ""
echo "3. Попробуй альтернативный shell:"
echo "   /bin/bash --noprofile --norc -c 'ssh root@109.172.46.200 echo OK'"
echo ""

echo "ШАГ 5: Восстановление (если что-то сломалось)"
echo "--------------------------------------------"
echo "Восстановить профили:"
echo "for f in ~/.bash_profile ~/.bash_login ~/.profile ~/.bashrc ~/.zshrc ~/.zprofile ~/.zlogin; do"
echo "  [ -f \"\$f.bak.*\" ] && ls \"\$f.bak.*\" | head -1 | xargs -I {} mv {} \"\$f\""
echo "done"
echo ""

echo "АЛЬТЕРНАТИВНОЕ РЕШЕНИЕ:"
echo "======================="
echo "Если ничего не помогает - работай только в Terminal.app:"
echo "- Для SSH: Terminal.app"
echo "- Для редактирования: Windsurf IDE"
echo "- Для копирования файлов: Terminal.app"
echo ""

echo "ГОТОВО К ИСПОЛЬЗОВАНИЮ! 🚀"
