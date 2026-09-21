import { z } from 'zod'
import { config } from './config.js'

function errorContent(err) {
  return { content: [{ type: 'text', text: `Erro: ${err.message}` }], isError: true }
}

function textContent(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] }
}

export function registerTools(server, browser) {
  server.registerTool(
    'vp_login',
    {
      title: 'Login no vpsistema.com',
      description:
        'Garante que a sessão do browser está autenticada em vpsistema.com com a conta de serviço configurada. Chame antes de qualquer outra ferramenta. Idempotente: se já estiver logado, apenas confirma.',
      inputSchema: {},
    },
    async () => {
      try {
        const status = await browser.ensureLoggedIn()
        return textContent({ loggedIn: true, ...status })
      } catch (err) {
        return errorContent(err)
      }
    },
  )

  server.registerTool(
    'vp_list_cards',
    {
      title: 'Listar cards do dashboard',
      description:
        'Lista os cards (sistemas/módulos) visíveis no dashboard do vpsistema.com para a conta logada, com nome e se está bloqueado (sem permissão).',
      inputSchema: {},
    },
    async () => {
      try {
        await browser.ensureLoggedIn()
        const cards = await browser.listCards()
        return textContent(cards)
      } catch (err) {
        return errorContent(err)
      }
    },
  )

  server.registerTool(
    'vp_open_card',
    {
      title: 'Abrir um card/sistema',
      description:
        'Clica no card cujo nome contém o texto informado (case-insensitive) e segue a sessão SSO para o subsistema, trocando o foco para a nova aba quando aplicável. Use vp_list_cards antes se não souber o nome exato.',
      inputSchema: {
        name: z.string().describe('Nome (ou parte do nome) do card, ex: "VP Click", "Engenharia"'),
      },
    },
    async ({ name }) => {
      try {
        await browser.ensureLoggedIn()
        const result = await browser.openCard(name)
        return textContent(result)
      } catch (err) {
        return errorContent(err)
      }
    },
  )

  server.registerTool(
    'vp_focus_portal',
    {
      title: 'Voltar para a aba do portal',
      description:
        'Torna a aba do vpsistema.com (portal) a aba ativa novamente, sem fechar a aba do card aberto. Use antes de vp_open_card se a última ação foi em um subsistema e você quer abrir outro card.',
      inputSchema: {},
    },
    async () => {
      try {
        const result = await browser.focusPortal()
        return textContent(result)
      } catch (err) {
        return errorContent(err)
      }
    },
  )

  server.registerTool(
    'vp_navigate',
    {
      title: 'Navegar para uma URL',
      description: `Navega a aba ativa para uma URL. Só é permitido dentro dos domínios: ${config.allowedDomains.join(', ')}.`,
      inputSchema: { url: z.string().url() },
    },
    async ({ url }) => {
      try {
        const result = await browser.navigate(url)
        return textContent(result)
      } catch (err) {
        return errorContent(err)
      }
    },
  )

  server.registerTool(
    'vp_status',
    {
      title: 'Status da aba ativa',
      description: 'Retorna a URL e o título atuais da aba que o browser está controlando.',
      inputSchema: {},
    },
    async () => {
      try {
        const result = await browser.withPage(async (page) => ({ url: page.url(), title: await page.title() }))
        return textContent(result)
      } catch (err) {
        return errorContent(err)
      }
    },
  )

  server.registerTool(
    'vp_click',
    {
      title: 'Clicar em um elemento',
      description:
        'Clica em um elemento da página ativa. Informe "text" (texto visível, ex: nome de um botão) ou "selector" (seletor CSS) — pelo menos um dos dois.',
      inputSchema: {
        text: z.string().optional().describe('Texto visível do elemento (parcial, case-insensitive)'),
        selector: z.string().optional().describe('Seletor CSS explícito'),
      },
    },
    async ({ text, selector }) => {
      try {
        if (!text && !selector) throw new Error('Informe "text" ou "selector".')
        const result = await browser.withPage(async (page) => {
          const locator = selector ? page.locator(selector).first() : page.getByText(text, { exact: false }).first()
          await locator.click({ timeout: 10000 })
          await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
          return { clicked: text || selector, url: page.url() }
        })
        return textContent(result)
      } catch (err) {
        return errorContent(err)
      }
    },
  )

  server.registerTool(
    'vp_fill',
    {
      title: 'Preencher um campo',
      description: 'Preenche um input/textarea da página ativa, identificado por seletor CSS, com o texto informado.',
      inputSchema: {
        selector: z.string().describe('Seletor CSS do campo, ex: input[name="email"]'),
        text: z.string(),
      },
    },
    async ({ selector, text }) => {
      try {
        const result = await browser.withPage(async (page) => {
          await page.locator(selector).first().fill(text, { timeout: 10000 })
          return { filled: selector }
        })
        return textContent(result)
      } catch (err) {
        return errorContent(err)
      }
    },
  )

  server.registerTool(
    'vp_press_key',
    {
      title: 'Pressionar uma tecla',
      description: 'Envia uma tecla do teclado para a página ativa (ex: "Enter", "Tab", "Escape").',
      inputSchema: { key: z.string() },
    },
    async ({ key }) => {
      try {
        await browser.withPage((page) => page.keyboard.press(key))
        return textContent({ pressed: key })
      } catch (err) {
        return errorContent(err)
      }
    },
  )

  server.registerTool(
    'vp_go_back',
    {
      title: 'Voltar página',
      description: 'Navega para trás no histórico da aba ativa.',
      inputSchema: {},
    },
    async () => {
      try {
        const result = await browser.withPage(async (page) => {
          await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {})
          return { url: page.url(), title: await page.title() }
        })
        return textContent(result)
      } catch (err) {
        return errorContent(err)
      }
    },
  )

  server.registerTool(
    'vp_read_page',
    {
      title: 'Ler conteúdo da página',
      description:
        'Retorna um resumo da página ativa: título, URL e os elementos interativos visíveis (botões, links, campos) com seus textos/labels — para decidir o próximo clique/preenchimento.',
      inputSchema: {},
    },
    async () => {
      try {
        const result = await browser.withPage(async (page) => {
          const elements = await page.evaluate(() => {
            const isVisible = (el) => {
              const r = el.getBoundingClientRect()
              const style = getComputedStyle(el)
              return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
            }
            const pick = (list, mapFn) =>
              Array.from(list)
                .filter(isVisible)
                .slice(0, 60)
                .map(mapFn)
            return {
              buttons: pick(document.querySelectorAll('button, [role="button"]'), (el) =>
                el.innerText?.trim().slice(0, 80),
              ).filter(Boolean),
              links: pick(document.querySelectorAll('a[href]'), (el) => ({
                text: el.innerText?.trim().slice(0, 80),
                href: el.href,
              })).filter((l) => l.text),
              inputs: pick(document.querySelectorAll('input, textarea, select'), (el) => ({
                name: el.name || null,
                type: el.type || el.tagName.toLowerCase(),
                placeholder: el.placeholder || null,
              })),
            }
          })
          const bodyText = await page
            .locator('body')
            .innerText()
            .catch(() => '')
          return {
            url: page.url(),
            title: await page.title(),
            elements,
            textPreview: bodyText.slice(0, 2000),
          }
        })
        return textContent(result)
      } catch (err) {
        return errorContent(err)
      }
    },
  )

  server.registerTool(
    'vp_screenshot',
    {
      title: 'Screenshot da página ativa',
      description: 'Captura um screenshot da aba ativa e retorna como imagem PNG.',
      inputSchema: { fullPage: z.boolean().optional().default(false) },
    },
    async ({ fullPage }) => {
      try {
        const buffer = await browser.withPage((page) => page.screenshot({ fullPage, type: 'png' }))
        return { content: [{ type: 'image', data: buffer.toString('base64'), mimeType: 'image/png' }] }
      } catch (err) {
        return errorContent(err)
      }
    },
  )
}
