# verticalparts-browser-mcp

> MCP server que loga em **vpsistema.com** com uma conta de serviço e opera os
> subsistemas ("cards" do portal) como um usuário humano autenticado —
> via Playwright (Chromium real, não scraping por API).

Uma sessão do Claude conectada a este MCP consegue: logar no portal,
listar os cards disponíveis, abrir um card específico (segue o SSO até o
subsistema, ex. VP Click, Engenharia, Suporte...) e então clicar, preencher
formulários, ler a tela e tirar screenshots — como se fosse um colaborador
usando o navegador.

## Por que existe

O [vpsistema.com](https://vpsistema.com) (repo `vpsistema`) é o portal SSO
central da VerticalParts: uma tela de login única que dá acesso, via cards,
a Catraca, Visitas, VPRequisições, Cotação Importação/PRD, VP Click,
Engenharia, Suporte, Propostas e Pós-Venda 360. Os conectores MCP anteriores
não cobriam "entrar no portal e operar a tela como humano" — este server foi
criado especificamente para isso, do zero.

## Como funciona

```
Claude ──MCP (Streamable HTTP)──> este servidor ──Playwright──> vpsistema.com
                                                                     │
                                                          clica um card (SSO)
                                                                     ▼
                                                        catraca / vpclick / ...
                                                        *.vpsistema.com
                                                        *.verticalparts.com
```

- Um `BrowserSession` por sessão MCP (uma aba Chromium controlada), com fila
  serializada — duas chamadas de ferramenta nunca clicam ao mesmo tempo.
- Sessão do vpsistema persistida em disco (`storageState`) para não logar de
  novo a cada restart.
- **Guarda de domínio**: qualquer navegação (`vp_navigate` ou um card cuja
  URL fuja do allow-list) é bloqueada, mesmo com a sessão autenticada.
  Configurável via `ALLOWED_DOMAINS` (padrão: `vpsistema.com,verticalparts.com`).

## Ferramentas MCP

| Ferramenta | O que faz |
|---|---|
| `vp_login` | Garante sessão autenticada (idempotente) |
| `vp_list_cards` | Lista os cards visíveis no dashboard (nome, bloqueado ou não) |
| `vp_open_card` | Clica um card por nome (match parcial) e segue o SSO até o subsistema |
| `vp_navigate` | Vai para uma URL (só dentro do allow-list) |
| `vp_status` | URL/título atuais da aba ativa |
| `vp_click` | Clica um elemento por texto visível ou seletor CSS |
| `vp_fill` | Preenche um input/textarea |
| `vp_press_key` | Envia uma tecla (Enter, Tab, Escape...) |
| `vp_go_back` | Volta no histórico |
| `vp_read_page` | Resumo da página: título, URL, botões/links/campos visíveis, texto |
| `vp_screenshot` | Screenshot PNG da aba ativa |

## Setup

### 1. Criar a conta de serviço dedicada

**Nunca** use uma conta pessoal — use uma conta própria do robô, auditável
nos `activity_logs` do vpsistema e revogável sem afetar ninguém.

1. Acesse `vpsistema.com` com uma conta Administrador
2. Card **Administração** → **+ Convidar**
3. Nome: `Claude Browser Bot` (ou o que preferir) · Departamento: o que fizer
   sentido · Nível: **Administrador** (para enxergar todos os cards)
4. Um e-mail de convite é enviado — defina a senha pelo link e guarde as
   credenciais para as variáveis de ambiente abaixo
5. Se algum sistema não puder ser acessado por essa conta, ajuste em
   **Administração → Permissões** do usuário

### 2. Variáveis de ambiente

```bash
cp .env.example .env
# preencha VPSISTEMA_EMAIL, VPSISTEMA_PASSWORD e gere um MCP_AUTH_TOKEN:
openssl rand -hex 32
```

Veja `.env.example` para a lista completa e o porquê de cada uma.

### 3. Rodar local

```bash
npm install
npm start
# servidor MCP (Streamable HTTP) em http://localhost:8787/mcp
```

### 4. Deploy (VPS Hostinger, mesma infra dos outros apps)

Via Docker (recomendado — a imagem `mcr.microsoft.com/playwright` já traz o
Chromium e as dependências do SO certas):

```bash
docker build -t verticalparts-browser-mcp .
docker run -d --name vp-browser-mcp \
  --env-file .env \
  -p 8787:8787 \
  -v vp-browser-mcp-data:/app/.data \
  --restart unless-stopped \
  verticalparts-browser-mcp
```

Depois, exponha via Nginx num subdomínio (ex. `browser-mcp.vpsistema.com`)
com HTTPS, apontando para a porta 8787 — os outros MCPs internos da
VerticalParts seguem o mesmo padrão de subdomínio + proxy reverso.

### 5. Registrar como connector no claude.ai

Nas configurações de Connectors da organização, adicione um MCP customizado
apontando para `https://browser-mcp.vpsistema.com/mcp`, com o header
`Authorization: Bearer <MCP_AUTH_TOKEN>` se você configurou o token (fortemente
recomendado). Depois disso o connector aparece disponível para as sessões do
Claude, do mesmo jeito que os outros MCPs internos da VerticalParts.

## Segurança

- A conta de serviço tem **acesso total** a todos os sistemas internos
  (nível Administrador) — trate as credenciais como trataria uma chave
  mestra, não como uma senha qualquer.
- `MCP_AUTH_TOKEN` é a única barreira entre "qualquer um com a URL" e "sessão
  logada como Administrador em produção" — não pule essa variável.
- O allow-list de domínios (`ALLOWED_DOMAINS`) impede que a sessão autenticada
  seja usada para navegar fora dos sistemas internos, mesmo por engano ou
  prompt injection numa página.
- Toda ação fica registrada nos `activity_logs` do vpsistema, sob o nome da
  conta de serviço — se algo parecer errado, é o primeiro lugar para olhar.

## Notas de implementação

- Os seletores de login (`input[name="vp-email"]`, `input[name="vp-password"]`)
  e o marcador de dashboard (`"Selecione o sistema que deseja acessar"`) foram
  tirados diretamente do código-fonte do `vpsistema`
  (`src/pages/Login.jsx`, `src/pages/Dashboard.jsx`) — se esses componentes
  mudarem de texto/estrutura, atualize `src/browserSession.js` junto.
- `vp_open_card` espera a aba nova que o Dashboard abre no clique (SSO);
  cards administrativos (Administração/Painel Executivo/Logs) navegam dentro
  da própria SPA, sem aba nova — o código trata os dois casos.
- Login não testado ponta a ponta com credenciais reais neste ambiente de
  desenvolvimento (rede via proxy do sandbox teve instabilidade carregando o
  bundle React da SPA). Antes de considerar produção pronta, rode
  `HEADLESS=false npm start` e chame `vp_login` uma vez observando a janela,
  ou acompanhe os logs do servidor no primeiro uso real.
