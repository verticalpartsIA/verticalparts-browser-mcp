import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { config, isAllowedUrl } from './config.js'

// Serializa todas as ações do browser: duas chamadas de ferramenta do Claude
// não podem clicar/navegar ao mesmo tempo na mesma aba.
class Mutex {
  #tail = Promise.resolve()

  run(fn) {
    const result = this.#tail.then(fn)
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

export class DomainBlockedError extends Error {
  constructor(url) {
    super(`Navegação bloqueada: "${url}" está fora dos domínios permitidos (${config.allowedDomains.join(', ')}).`)
    this.name = 'DomainBlockedError'
  }
}

export class BrowserSession {
  #browser = null
  #context = null
  #page = null
  // Aba do portal (vpsistema.com/login) separada da aba "ativa": abrir um
  // card troca a ativa para o subsistema, mas listar/abrir OUTRO card depois
  // precisa continuar achando a grade no portal, não no subsistema aberto.
  #portalPage = null
  #mutex = new Mutex()
  #loggedIn = false

  async #ensureBrowser() {
    if (!this.#browser) {
      this.#browser = await chromium.launch({
        headless: config.headless,
        executablePath: config.executablePath,
      })
    }
    if (!this.#context) {
      const stateFile = path.resolve(config.storageStatePath)
      const hasState = fs.existsSync(stateFile)
      this.#context = await this.#browser.newContext({
        storageState: hasState ? stateFile : undefined,
        viewport: { width: 1366, height: 900 },
      })
      this.#context.setDefaultTimeout(15000)
    }
    if (!this.#portalPage || this.#portalPage.isClosed()) {
      const pages = this.#context.pages()
      this.#portalPage = pages[0] || (await this.#context.newPage())
    }
    if (!this.#page || this.#page.isClosed()) {
      this.#page = this.#portalPage
    }
  }

  async #persistState() {
    const stateFile = path.resolve(config.storageStatePath)
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    await this.#context.storageState({ path: stateFile })
  }

  async #performLogin() {
    const { baseUrl, email, password } = config.vpsistema
    const page = this.#portalPage
    await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' })

    const emailInput = page.locator('input[name="vp-email"]')
    const dashboardMarker = page.getByText('Selecione o sistema que deseja acessar')

    // App React (Vite) — o HTML inicial fica quase vazio até o bundle carregar
    // e montar a tela. "domcontentloaded" dispara antes disso, então checar o
    // campo de e-mail na hora daria falso negativo (pareceria "já logado").
    // Espera o que aparecer primeiro: tela de login ou dashboard (storageState
    // válido pulou o login).
    const alreadyIn = await Promise.race([
      emailInput.waitFor({ state: 'visible', timeout: 20000 }).then(() => false),
      dashboardMarker.waitFor({ state: 'visible', timeout: 20000 }).then(() => true),
    ]).catch(() => {
      throw new Error('vpsistema.com não respondeu: nem a tela de login nem o dashboard apareceram em 20s.')
    })

    if (!alreadyIn) {
      await emailInput.fill(email)
      await page.locator('input[name="vp-password"]').fill(password)
      await page.getByRole('button', { name: /^Entrar/ }).click()
      await dashboardMarker.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {
        throw new Error(
          'Login em vpsistema.com falhou: o dashboard não carregou. Verifique VPSISTEMA_EMAIL/VPSISTEMA_PASSWORD e se a conta está ativa.',
        )
      })
    }

    this.#loggedIn = true
    await this.#persistState()
  }

  /**
   * Garante sessão autenticada. Esta SPA não tem rota "/dashboard" de
   * verdade — login e dashboard vivem na mesma URL, trocando de componente
   * por estado React — então a única forma confiável de saber se já está
   * logado é o flag em memória (a sessão do Supabase persiste em
   * localStorage dentro do storageState salvo em disco).
   */
  async ensureLoggedIn() {
    return this.#mutex.run(async () => {
      await this.#ensureBrowser()
      if (!this.#loggedIn) {
        await this.#performLogin()
      }
      return { url: this.#page.url(), title: await this.#page.title() }
    })
  }

  /** Executa uma ação arbitrária com a página ativa, sob o mutex. */
  async withPage(fn) {
    return this.#mutex.run(async () => {
      await this.#ensureBrowser()
      return fn(this.#page)
    })
  }

  /** Como withPage, mas sempre na aba do portal (onde vive a grade de cards). */
  async withPortalPage(fn) {
    return this.#mutex.run(async () => {
      await this.#ensureBrowser()
      await this.#portalPage.bringToFront().catch(() => {})
      return fn(this.#portalPage)
    })
  }

  /** Troca a página "ativa" (ex.: depois de abrir um card em nova aba). */
  setActivePage(page) {
    this.#page = page
  }

  get activePage() {
    return this.#page
  }

  /** Volta a aba ativa para o portal (útil depois de abrir um card, pra abrir outro). */
  async focusPortal() {
    return this.withPortalPage(async (page) => {
      this.setActivePage(page)
      return { url: page.url(), title: await page.title() }
    })
  }

  async navigate(url) {
    if (!isAllowedUrl(url)) throw new DomainBlockedError(url)
    return this.withPage(async (page) => {
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      return { url: page.url(), title: await page.title() }
    })
  }

  async listCards() {
    return this.withPortalPage(async (page) => {
      const cards = page.locator('main button:has(h3)')
      const count = await cards.count()
      const result = []
      for (let i = 0; i < count; i++) {
        const card = cards.nth(i)
        const name = (await card.locator('h3').innerText()).trim()
        const locked = (await card.getAttribute('class'))?.includes('opacity-35') ?? false
        result.push({ name, locked })
      }
      return result
    })
  }

  /** Clica um card pelo nome (match parcial, case-insensitive) e segue a aba nova (se abrir). */
  async openCard(nameQuery) {
    return this.withPortalPage(async (page) => {
      const card = page.locator('main button:has(h3)').filter({
        has: page.locator('h3', { hasText: new RegExp(nameQuery, 'i') }),
      })
      const total = await card.count()
      if (total === 0) {
        throw new Error(`Nenhum card encontrado com nome contendo "${nameQuery}". Use vp_list_cards para ver os nomes disponíveis.`)
      }
      const target = card.first()
      const cardName = (await target.locator('h3').innerText()).trim()

      let popup = null
      try {
        ;[popup] = await Promise.all([
          this.#context.waitForEvent('page', { timeout: 5000 }),
          target.click(),
        ])
      } catch {
        // Card sem SSO (navegação interna na SPA, ex.: Administração) — sem aba nova.
      }

      if (popup) {
        await popup.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {})
        const popupUrl = popup.url()
        if (popupUrl !== 'about:blank' && !isAllowedUrl(popupUrl)) {
          await popup.close()
          throw new DomainBlockedError(popupUrl)
        }
        this.setActivePage(popup)
        return { card: cardName, url: popup.url(), title: await popup.title().catch(() => '') }
      }

      // Card sem SSO (Administração/Painel Executivo/Logs): a view troca por
      // estado React na própria aba do portal, sem navegação — a aba ativa
      // passa a ser a do portal, que é onde a view nova está renderizada.
      await page.waitForLoadState('domcontentloaded').catch(() => {})
      this.setActivePage(page)
      return { card: cardName, url: page.url(), title: await page.title() }
    })
  }

  async close() {
    await this.#context?.close().catch(() => {})
    await this.#browser?.close().catch(() => {})
    this.#browser = null
    this.#context = null
    this.#page = null
    this.#portalPage = null
    this.#loggedIn = false
  }
}
