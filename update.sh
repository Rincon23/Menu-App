#!/bin/bash
set -e
# Roda da pasta do projeto, de onde quer que o script seja chamado.
cd "$(dirname "$0")"

echo "==> Baixando últimas mudanças do GitHub..."
git pull

# Sem "down" antes: o site continua no ar durante o build e o compose só
# recria os containers cuja imagem mudou.
echo "==> Reconstruindo e reiniciando os containers..."
docker compose up -d --build

echo "==> Pronto! Site atualizado."
