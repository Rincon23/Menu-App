# Rincon Menu

Hub pessoal de apps — `menu.rincon.dev.br`.

## Estrutura
```
rincon-menu-app/
├── Dockerfile          # build multi-stage: Node builda, Nginx serve
├── docker-compose.yml  # sobe os dois containers (site + checador)
├── nginx.conf          # config do Nginx: serve o site e faz proxy de /api pro checador
├── index.html
├── package.json
├── vite.config.js
├── server/             # checador de status (Node puro, sem dependências)
│   ├── index.js        # API POST /api/status — pinga cada serviço pelo servidor
│   └── Dockerfile
└── src/
    ├── main.jsx         # entry point
    └── RinconMenu.jsx   # o componente da página (edite aqui pra add/remover apps)
```

## Indicador de status (no ar / fora do ar)

Cada card mostra uma bolinha: **verde** = no ar, **vermelha** = fora do ar,
**amarela** = não foi possível verificar (o próprio checador está fora), cinza =
verificando. O front (`RinconMenu.jsx`) manda a lista de URLs pro container
`rincon-menu-checker`, que dá um `curl` em cada uma **a partir do servidor** e
aplica uma regra simples:

- status HTTP de **origem fora do ar** (502/503/504/52x/530) → fora do ar
- corpo é a página de **erro do Cloudflare Tunnel / "bad gateway"** → fora do ar
- erro de rede / DNS / timeout → fora do ar
- qualquer outra resposta → no ar

Precisa ser no servidor (e não direto no navegador) porque o navegador não
consegue **ler o corpo** de uma resposta de outro domínio — o CORS bloqueia.
O resultado é cacheado por 30s e o front revalida a cada 60s.

Por segurança (anti-SSRF) o checador só aceita hosts dentro de
`.rincon.dev.br` — ajuste `ALLOWED_HOST_SUFFIX` no `docker-compose.yml` se
mudar de domínio. Hosts públicos extras que aparecem no menu (ex.:
`cloudflare.com`) ficam em `ALLOWED_EXACT_HOSTS` (lista separada por vírgula).

## Editar os apps
Abra `src/RinconMenu.jsx` e edite o array `GROUPS` no topo do arquivo. Cada grupo vira uma seção na página:

```js
{
  id: "id-unico",
  name: "Nome do App",
  desc: "Descrição curta",
  url: "https://...",
  domain: "dominio.com",   // usado pra buscar o favicon automaticamente
  accent: "#3B6FE0",       // cor de destaque do card
  Icon: Globe,             // ícone de fallback (lucide-react)
}
```

## Rodar localmente (sem Docker, pra testar)
```bash
npm install
npm run dev
```
Abre em `http://localhost:5173`.

Pra testar o indicador de status junto, suba o checador em outro terminal
(o Vite já encaminha `/api` pra ele):
```bash
cd server && npm start   # sobe em http://localhost:3001
```

## Build e deploy com Docker

### 1. Build da imagem e subir o container
No diretório do projeto (onde está o `docker-compose.yml`):
```bash
docker compose up -d --build
```
Isso builda as duas imagens (o site estático + o checador de status) e sobe o Nginx servindo na porta `8090` do host (`http://IP_DO_ORANGEPI:8090`). O container `rincon-menu-checker` não expõe porta — só o Nginx fala com ele pela rede interna do compose.

Pra rebuildar depois de editar o `RinconMenu.jsx`:
```bash
docker compose up -d --build
```

### 2. Conectar ao seu domínio (menu.rincon.dev.br)
Depende de como você já expõe os outros subdomínios (`n8n.rincon.dev.br`, `portainer.rincon.dev.br`, etc). Duas situações comuns:

**Se você usa Nginx Proxy Manager ou Traefik:**
- Coloque o container `rincon-menu` na mesma rede Docker do proxy (edite o `docker-compose.yml`, seção `networks`, comentada por padrão).
- No proxy, crie um novo host apontando `menu.rincon.dev.br` → `rincon-menu:80` (nome do container, porta interna 80 — não a `8090`).
- Ative SSL como você já faz nos outros.

**Se você expõe via porta direta + DNS:**
- Aponte o registro DNS de `menu.rincon.dev.br` pro IP do seu Orange Pi.
- Mantenha o mapeamento `8090:80` do compose e libere/redirecione a porta no seu roteador ou proxy existente.

### 3. Testar
```bash
curl -I http://localhost:8090
```
Deve retornar `200 OK`. Depois é só abrir `menu.rincon.dev.br` no navegador.

## Atualizar depois de um push no GitHub

1. Clone o repo uma vez no Orange Pi: `git clone https://github.com/SEU-USUARIO/rincon-menu.git`
2. Depois de cada `git push` feito na sua máquina, no Orange Pi rode:
   ```bash
   ./update.sh
   ```
   (ou manualmente: `git pull && docker compose down && docker compose up -d --build`)

Alternativa sem precisar de `git pull`: configure o `build.context` do `docker-compose.yml` pra apontar direto pra URL do seu repositório no GitHub (exemplo comentado dentro do arquivo). Só funciona bem com repositório **público** — com repositório privado é preciso configurar autenticação extra no Docker.

## Notas
- Os ícones dos apps são buscados automaticamente via favicon do domínio (`google.com/s2/favicons`) — precisa de internet na hora de carregar a página (não no build).
- Favoritos ficam salvos só na sessão (na memória do navegador) — se quiser persistência entre acessos, dá pra adicionar `localStorage` direto no `RinconMenu.jsx` (fora do ambiente de artifact isso funciona normalmente).
