import express from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { config } from './config.js'
import { BrowserSession } from './browserSession.js'
import { registerTools } from './tools.js'

const app = express()
app.use(express.json())

// Autenticação simples por bearer token, se MCP_AUTH_TOKEN estiver configurado.
// Sem isso, qualquer um que descubra a URL controla uma sessão autenticada
// como Administrador em todos os sistemas internos da VerticalParts.
app.use((req, res, next) => {
  if (!config.mcpAuthToken) return next()
  const auth = req.headers.authorization || ''
  if (auth === `Bearer ${config.mcpAuthToken}`) return next()
  res.status(401).json({ error: 'unauthorized' })
})

app.get('/health', (_req, res) => res.json({ ok: true }))

// Um único browser (uma identidade, uma conta de serviço) compartilhado por
// todo mundo que chamar este servidor — não um por cliente/sessão MCP. O
// próprio BrowserSession já serializa as ações (mutex interno).
const browser = new BrowserSession()

// Transporte MCP em modo stateless: sem session-id, sem estado por conexão
// guardado em memória. Isso é proposital, não só simplicidade — a versão
// anterior (com sessionIdGenerator) guardava sessão em memória por
// mcp-session-id; um restart do processo (deploy, crash, systemd) derrubava
// todas as sessões de todo mundo, e qualquer cliente com o session-id antigo
// ficava travado permanentemente em "Sessão inexistente. Envie um initialize
// primeiro" — inclusive em conversas novas, porque o cliente reutiliza o
// session-id da conexão do connector. Sem sessão para perder, não tem esse
// jeito de travar: cada request cria um McpServer+transport efêmeros, mas o
// estado que importa de verdade (o browser logado) vive fora disso, no
// `browser` acima.
app.post('/mcp', async (req, res) => {
  const server = new McpServer({ name: 'verticalparts-browser-mcp', version: '0.1.0' })
  registerTools(server, browser)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    transport.close().catch(() => {})
    server.close().catch(() => {})
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
})

app.get('/mcp', (_req, res) => {
  res.status(405).json({ error: 'Modo stateless: sem stream de notificações do servidor via GET.' })
})

app.delete('/mcp', (_req, res) => {
  res.status(405).json({ error: 'Modo stateless: não há sessão para encerrar.' })
})

// Só loopback: o Nginx faz o proxy reverso com auth. Exposto em 0.0.0.0
// seria alcançável direto da internet sem nenhuma checagem (erro já visto
// em produção no vpprd-mcp, porta 3100).
app.listen(config.port, config.host, () => {
  console.log(`verticalparts-browser-mcp ouvindo em ${config.host}:${config.port}`)
})

process.on('SIGTERM', async () => {
  await browser.close().catch(() => {})
  process.exit(0)
})
