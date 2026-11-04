# Rincon Menu

Hub pessoal de apps — `menu.rincon.dev.br`.

## Estrutura
```
rincon-menu-app/
├── Dockerfile          # build multi-stage: Node builda, Nginx serve
├── docker-compose.yml  # sobe os dois containers (site + checador)
├── docker-compose.agent.yml  # agente de métricas pra rodar no Servidor
├── nginx.conf          # config do Nginx: serve o site e faz proxy de /api pro checador
├── index.html
├── package.json
├── vite.config.js
├── server/             # checador (Node; única dependência: ws)
│   ├── index.js        # status, métricas, login, layout dos links e terminal
│   └── Dockerfile
└── src/
    ├── main.jsx         # entry point
    ├── RinconMenu.jsx   # o componente da página (e a lista padrão de apps)
    └── TerminalPanel.jsx  # terminal no navegador (xterm.js, só carrega logado)
```

## Login, modo edição e terminal

Sem login o menu funciona como sempre. Clicando no ícone de entrar (canto
superior direito) e digitando a senha e o código de 2 fatores, aparecem:

- **Modo edição** (ícone de lápis): arraste os cards pra mudar a ordem ou a
  seção, o olho oculta o link pra quem não está logado, o lápis edita e o
  "+ adicionar link" no fim de cada seção cria um novo. Tudo salva na hora,
  no servidor (vale pra qualquer navegador). O arraste é de mouse — no
  celular não funciona.
- **Terminal** (botão `terminal` no cabeçalho do Orange Pi e do Servidor): um
  shell no host da máquina, como um ssh — `htop`, `nano`, `docker logs -f`
  funcionam. Por baixo, o checador cria pelo socket do Docker um container
  descartável e privilegiado que roda `nsenter -t 1 ... su -l` no host; ao
  fechar o painel ele é apagado. O do Servidor passa pelo agente (Tailscale).

### Configurar (uma vez)

1. **No Orange Pi**, acrescente a senha no `.env` (gere uma forte, ela dá
   root nas duas máquinas): `openssl rand -base64 18`
   ```
   ADMIN_PASSWORD=COLE_A_SENHA_AQUI
   ```
   Opcional, nas duas máquinas: `TERMINAL_USER=orangepi` (ou o seu usuário)
   pra o terminal abrir nele em vez de `root`.
   Depois `./update.sh`.
2. **2 fatores (2FA)**: gere uma chave com o menu já atualizado rodando:
   ```bash
   docker compose exec rincon-menu-checker node totp.js
   ```
   (ou `node server/totp.js` em qualquer máquina com Node). Ele mostra a
   linha `ADMIN_TOTP_SECRET=...` — coloque no `.env` do Orange Pi — e a chave
   pra cadastrar no app autenticador (Google Authenticator, Aegis, Authy...:
   "inserir chave manualmente", baseada em tempo). Rode `./update.sh` de novo.
   A partir daí o login pede o código de 6 dígitos. Se perder o celular, gere
   outra chave e troque no `.env`.

   Evite guardar o código 2FA no mesmo Vaultwarden onde está a senha do
   menu: se o cofre vazar, os dois fatores vão juntos.
3. **No Servidor**, atualize o agente (é ele que abre o terminal de lá):
   ```bash
   cd Menu-App
   git pull
   docker compose -f docker-compose.agent.yml up -d --build
   ```

### Segurança

- Login = senha + código 2FA (TOTP, o mesmo padrão do Google Authenticator);
  um código já usado não entra de novo.
- A sessão é um cookie assinado (30 dias, `HttpOnly`, `SameSite=Strict`);
  trocar a `ADMIN_PASSWORD` ou a `ADMIN_TOTP_SECRET` derruba todas. 5
  tentativas erradas seguidas bloqueiam o IP por 15 minutos.
- O checador recusa pedidos de outros sites (confere o `Origin`), inclusive
  de outros `*.rincon.dev.br`.
- Recomendado: proteger o caminho `menu.rincon.dev.br/api/terminal` com uma
  aplicação do **Cloudflare Access** (login por e-mail), como segunda trava.
- No Servidor, quem tem o `AGENT_TOKEN` tem um shell. Pra só o Tailscale
  enxergar a porta do agente, troque no `docker-compose.agent.yml` por
  `"100.x.y.z:3002:3001"` (IP do Servidor no Tailscale).

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

## RAM, disco e containers de cada seção

As seções **Orange Pi** e **Servidor** mostram no cabeçalho a RAM e o disco
da máquina, e um botão (ícone de caixa + número) que abre a lista dos
containers rodando com a RAM e o disco de cada um. Atualiza a cada 30s.

- **RAM do container** = mesma conta do `docker stats`.
- **Disco do container** = imagem + camada gravável + volumes nomeados.
  Pastas do host montadas direto (bind mounts, tipo a mídia do Jellyfin)
  não entram na conta.
- **Disco da máquina** = o disco onde o Docker guarda os dados.

Como funciona: o checador lê as métricas do próprio host (precisa do
`/var/run/docker.sock` montado, já está no `docker-compose.yml`). Pro
Servidor, roda no Servidor um "agente" (o mesmo checador) e o checador do
Orange Pi busca as métricas dele pelo Tailscale, protegido por um token.

### Configurar (uma vez)

1. Gere um token (qualquer máquina): `openssl rand -hex 24`
2. **No Servidor**: clone o repo, crie o `.env` e suba o agente:
   ```bash
   git clone https://github.com/Rincon23/Menu-App.git
   cd Menu-App
   echo "AGENT_TOKEN=COLE_O_TOKEN_AQUI" > .env
   docker compose -f docker-compose.agent.yml up -d --build
   ```
   (porta `3002` no host — troque no `docker-compose.agent.yml` se já estiver em uso)
3. **No Orange Pi**: crie o `.env` ao lado do `docker-compose.yml` (modelo em
   `.env.example`) com o mesmo token e o IP do Servidor no Tailscale
   (`tailscale ip -4` no Servidor). Use o IP `100.x`, não o nome MagicDNS —
   de dentro do container o nome pode não resolver.
   ```
   AGENT_TOKEN=COLE_O_TOKEN_AQUI
   SERVIDOR_AGENT_URL=http://100.x.y.z:3002
   ```
   Depois `./update.sh`.

Se o agente não responder, a seção mostra "métricas indisponíveis".

## Editar os apps
O jeito normal agora é pelo **modo edição** (ver "Login, modo edição e
terminal"). O layout salvo fica no volume `rincon-menu-data`
(`/data/links.json` dentro do checador).

O array `DEFAULT_GROUPS` no topo de `src/RinconMenu.jsx` é só o layout
inicial: depois do primeiro salvamento pelo modo edição, mudar ele no código
não muda mais o menu (pra voltar a ele, apague o `links.json` do volume). Cada
app tem este formato:

```js
{
  id: "id-unico",
  name: "Nome do App",
  desc: "Descrição curta",
  url: "https://...",
  domain: "dominio.com",   // texto mostrado no rodapé do card
  accent: "#3B6FE0",       // cor de destaque do card
  icon: "Globe",           // nome de um ícone do objeto ICONS
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
cd server && npm install && npm start   # sobe em http://localhost:3001
```
Pra testar o login, suba o checador com `ADMIN_PASSWORD=uma-senha npm start`
(no PowerShell: `$env:ADMIN_PASSWORD="uma-senha"` antes do `npm start`). O
terminal precisa de Docker na máquina.

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
   (ou manualmente: `git pull && docker compose up -d --build`)

Alternativa sem precisar de `git pull`: configure o `build.context` do `docker-compose.yml` pra apontar direto pra URL do seu repositório no GitHub (exemplo comentado dentro do arquivo). Só funciona bem com repositório **público** — com repositório privado é preciso configurar autenticação extra no Docker.

## Notas
- Os ícones dos apps são buscados automaticamente via favicon do domínio (`google.com/s2/favicons`) — precisa de internet na hora de carregar a página (não no build).
- Favoritos ficam salvos só na sessão (na memória do navegador) — se quiser persistência entre acessos, dá pra adicionar `localStorage` direto no `RinconMenu.jsx` (fora do ambiente de artifact isso funciona normalmente).
