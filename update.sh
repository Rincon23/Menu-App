#!/bin/bash
set -e
echo "==> Baixando últimas mudanças do GitHub..."
git pull

echo "==> Reconstruindo e reiniciando o container..."
docker compose down
docker compose up -d --build

echo "==> Pronto! Site atualizado."
