#!/bin/bash
# Define (ou troca) a senha do login do menu. A senha não fica gravada em
# lugar nenhum: o .env guarda só o hash dela (ADMIN_PASSWORD_HASH).
# Rode no Orange Pi, com o menu no ar:  ./definir-senha.sh
set -e
cd "$(dirname "$0")"

read -rsp "Nova senha do menu (mínimo 12 caracteres): " senha
echo
read -rsp "Repita a senha: " senha2
echo
if [ "$senha" != "$senha2" ]; then
  echo "As senhas não batem."
  exit 1
fi

linha=$(printf '%s' "$senha" | docker compose exec -T rincon-menu-checker node password.js)
unset senha senha2

touch .env
chmod 600 .env
sed -i '/^ADMIN_PASSWORD=/d; /^ADMIN_PASSWORD_HASH=/d' .env
if [ -n "$(tail -c1 .env)" ]; then echo >> .env; fi
echo "$linha" >> .env

echo "==> Reiniciando o checador com a senha nova..."
docker compose up -d rincon-menu-checker
echo "==> Pronto. Sessões abertas foram encerradas: entre de novo com a senha e o código 2FA."
