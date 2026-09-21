import 'dotenv/config'

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`)
  return value
}

export const config = {
  port: Number(process.env.PORT || 8787),
  mcpAuthToken: process.env.MCP_AUTH_TOKEN || null,
  vpsistema: {
    baseUrl: (process.env.VPSISTEMA_URL || 'https://vpsistema.com').replace(/\/$/, ''),
    email: required('VPSISTEMA_EMAIL'),
    password: required('VPSISTEMA_PASSWORD'),
  },
  allowedDomains: (process.env.ALLOWED_DOMAINS || 'vpsistema.com,verticalparts.com')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean),
  storageStatePath: process.env.STORAGE_STATE_PATH || './.data/storage-state.json',
  headless: process.env.HEADLESS !== 'false',
  // Só necessário se o Chromium do Playwright não estiver no cache padrão
  // (ex.: imagem com browser pré-instalado em outro caminho).
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
}

export function isAllowedUrl(urlString) {
  let parsed
  try {
    parsed = new URL(urlString)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  return config.allowedDomains.some(
    (domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`),
  )
}
