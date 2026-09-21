import express from 'express'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
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

/** @type {Map<string, { transport: StreamableHTTPServerTransport, browser: BrowserSession }>} */
const sessions = new Map()

async function createSessionEntry() {
  const browser = new BrowserSession()
  const server = new McpServer({ name: 'verticalparts-browser-mcp', version: '0.1.0' })
  registerTools(server, browser)

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => sessions.set(sessionId, entry),
  })

  transport.onclose = () => {
    if (transport.sessionId) {
      sessions.get(transport.sessionId)?.browser.close().catch(() => {})
      sessions.delete(transport.sessionId)
    }
  }

  const entry = { transport, browser }
  await server.connect(transport)
  return entry
}

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id']
  let entry = sessionId ? sessions.get(sessionId) : undefined

  if (!entry) {
    if (!isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Sessão inexistente. Envie um request initialize primeiro.' },
        id: null,
      })
      return
    }
    entry = await createSessionEntry()
  }

  await entry.transport.handleRequest(req, res, req.body)
})

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id']
  const entry = sessionId ? sessions.get(sessionId) : undefined
  if (!entry) {
    res.status(400).send('Sessão inexistente')
    return
  }
  await entry.transport.handleRequest(req, res)
})

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id']
  const entry = sessionId ? sessions.get(sessionId) : undefined
  if (entry) await entry.transport.handleRequest(req, res)
  else res.status(400).send('Sessão inexistente')
})

// Só loopback: o Nginx faz o proxy reverso com auth. Exposto em 0.0.0.0
// seria alcançável direto da internet sem nenhuma checagem (erro já visto
// em produção no vpprd-mcp, porta 3100).
app.listen(config.port, config.host, () => {
  console.log(`verticalparts-browser-mcp ouvindo em ${config.host}:${config.port}`)
})

process.on('SIGTERM', async () => {
  for (const entry of sessions.values()) await entry.browser.close().catch(() => {})
  process.exit(0)
})
