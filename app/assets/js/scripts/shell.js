'use strict'

const SHELL_ROUTES = Object.freeze({
    home: 'home',
    community: 'community',
    schematics: 'community/schematics',
    news: 'news',
    settings: 'settings'
})

let shellRoute = SHELL_ROUTES.home
let communityRegistry = null
let communityInitialized = false

function setHidden(element, hidden){
    if(!element) return
    element.hidden = hidden
    element.setAttribute('aria-hidden', hidden ? 'true' : 'false')
}

function setShellNavigationState(route){
    document.querySelectorAll('[data-shell-route]').forEach((button) => {
        const selected = button.dataset.shellRoute === route ||
            (button.dataset.shellRoute === SHELL_ROUTES.community && route.startsWith('community'))
        if(selected) button.setAttribute('aria-current', 'page')
        else button.removeAttribute('aria-current')
    })
}

function applyLandingRoute(route){
    const landing = document.getElementById('landingContainer')
    const home = document.getElementById('upper')
    const hub = document.getElementById('communityHub')
    const news = document.getElementById('newsContainer')
    const schematics = document.getElementById('schematicsContainer')
    if(!landing) return

    landing.dataset.shellRoute = route
    setHidden(home, route !== SHELL_ROUTES.home)
    setHidden(hub, route !== SHELL_ROUTES.community)
    setHidden(news, route !== SHELL_ROUTES.news)
    setHidden(schematics, route !== SHELL_ROUTES.schematics)
    setShellNavigationState(route)
    shellRoute = route
    window.dispatchEvent(new CustomEvent('helios:shell-route-change', { detail: { route } }))
}

async function getRawDistribution(){
    const distribution = await DistroAPI.getDistribution()
    return distribution?.rawDistribution || {}
}

function createModuleCard(definition){
    const article = document.createElement('article')
    article.className = 'communityModuleCard workshopPanel'
    article.setAttribute('role', 'listitem')
    article.dataset.communityModule = definition.id

    const icon = document.createElement('div')
    icon.className = 'communityModuleIcon itemSlot'
    icon.innerHTML = '<svg aria-hidden="true"><use href="assets/brand/allegator-icons.svg#community"></use></svg>'

    const copy = document.createElement('div')
    copy.className = 'communityModuleCopy'
    const meta = document.createElement('span')
    meta.className = 'workshopEyebrow'
    meta.textContent = Lang.query(definition.metaKey)
    const title = document.createElement('h2')
    title.textContent = Lang.query(definition.labelKey)
    const description = document.createElement('p')
    description.textContent = Lang.query(definition.descriptionKey)
    copy.append(meta, title, description)

    const action = document.createElement('button')
    action.type = 'button'
    action.className = 'workshopButton primary'
    action.textContent = Lang.query(definition.actionKey)
    action.addEventListener('click', async () => {
        action.disabled = true
        article.dataset.loading = 'true'
        try {
            await definition.load?.({ ensureReady: ensureSchematicsReady })
            await definition.open({ navigate: navigateShellRoute })
        } finally {
            action.disabled = false
            delete article.dataset.loading
        }
    })

    article.append(icon, copy, action)
    return article
}

async function initializeCommunityHub(force = false){
    if(communityInitialized && !force) return
    const grid = document.getElementById('communityModuleGrid')
    const empty = document.getElementById('communityHubEmpty')
    const connection = document.getElementById('communityConnectionState')
    if(!grid || !window.CommunityModules) return

    grid.replaceChildren()
    connection.textContent = Lang.query('ejs.community.checking')
    communityRegistry ||= window.CommunityModules.createDefaultCommunityRegistry()
    try {
        const rawDistribution = await getRawDistribution()
        const modules = await communityRegistry.enabled({ rawDistribution })
        modules.forEach((definition) => grid.appendChild(createModuleCard(definition)))
        setHidden(empty, modules.length > 0)
        connection.textContent = Lang.query('ejs.community.online')
        connection.dataset.state = 'online'
        communityInitialized = true
    } catch(err){
        loggerLanding?.warn?.('Failed to initialize the Community hub.', err)
        setHidden(empty, false)
        connection.textContent = Lang.query('ejs.community.offline')
        connection.dataset.state = 'offline'
    }
}

async function navigateShellRoute(route){
    const next = Object.values(SHELL_ROUTES).includes(route) ? route : SHELL_ROUTES.home

    if(next === SHELL_ROUTES.settings){
        document.getElementById('settingsMediaButton')?.click()
        return
    }

    if(getCurrentView() !== VIEWS.landing){
        switchView(getCurrentView(), VIEWS.landing)
    }

    if(next === SHELL_ROUTES.news){
        if(schematicsActive) document.getElementById('schematicsButton')?.click()
        if(!newsActive) document.getElementById('newsButton')?.click()
        return
    }

    if(next === SHELL_ROUTES.schematics){
        if(newsActive) document.getElementById('newsButton')?.click()
        if(!schematicsActive) document.getElementById('schematicsButton')?.click()
        return
    }

    if(newsActive) document.getElementById('newsButton')?.click()
    if(schematicsActive) document.getElementById('schematicsButton')?.click()
    applyLandingRoute(next)
    if(next === SHELL_ROUTES.community) await initializeCommunityHub()
}

function setApplicationView(view){
    const appShell = document.getElementById('appShell')
    const isShellView = view === VIEWS.landing || view === VIEWS.settings
    if(appShell) appShell.hidden = !isShellView
    document.body.dataset.applicationView = view === VIEWS.settings ? 'settings' : (isShellView ? 'launcher' : 'authentication')
    if(view === VIEWS.settings){
        setShellNavigationState(SHELL_ROUTES.settings)
    } else if(view === VIEWS.landing){
        setShellNavigationState(shellRoute)
    }
}

function countOptionalModules(modules = []){
    let count = 0
    for(const module of modules){
        if(module?.getRequired && module.getRequired().value === false) count++
        count += countOptionalModules(module?.subModules || [])
    }
    return count
}

async function refreshHomeSummary(){
    try {
        const distribution = await DistroAPI.getDistribution()
        const server = distribution.getServerById(ConfigManager.getSelectedServer())
        if(!server) return
        document.getElementById('homeProfileName').textContent = server.rawServer.name
        document.getElementById('homeProfileDescription').textContent = server.rawServer.description || Lang.query('ejs.home.profileDescription')
        document.getElementById('homeProfileVersion').textContent = server.rawServer.version || '—'
        document.getElementById('homeMinecraftVersion').textContent = server.rawServer.minecraftVersion || '—'
        const optional = countOptionalModules(server.modules)
        document.getElementById('homeOptionalMods').textContent = Lang.query('ejs.home.optionalAvailable', { count: optional })
        const channelName = ChannelManager?.channel?.channel || (isDev ? 'development' : 'stable')
        document.getElementById('homeChannelValue').textContent = String(channelName).toUpperCase()
    } catch(err){
        loggerLanding?.warn?.('Failed to refresh the Home summary.', err)
    }
}

function initializeShell(){
    document.getElementById('shellNavHome')?.addEventListener('click', () => navigateShellRoute(SHELL_ROUTES.home))
    document.getElementById('shellNavCommunity')?.addEventListener('click', () => navigateShellRoute(SHELL_ROUTES.community))
    document.getElementById('shellNavNews')?.addEventListener('click', () => navigateShellRoute(SHELL_ROUTES.news))
    document.getElementById('homeCommunityButton')?.addEventListener('click', () => navigateShellRoute(SHELL_ROUTES.community))

    const linksButton = document.getElementById('shellLinksButton')
    const linksMenu = document.getElementById('shellLinksMenu')
    linksButton?.addEventListener('click', () => {
        const open = linksMenu.hidden
        linksMenu.hidden = !open
        linksButton.setAttribute('aria-expanded', String(open))
    })
    document.addEventListener('click', (event) => {
        if(!linksMenu?.hidden && !event.target.closest('#shellLinks')){
            linksMenu.hidden = true
            linksButton?.setAttribute('aria-expanded', 'false')
        }
    })

    window.addEventListener('helios:distribution-refresh', () => {
        communityInitialized = false
        refreshHomeSummary()
    })
    applyLandingRoute(SHELL_ROUTES.home)
    refreshHomeSummary()
    if(typeof getCurrentView === 'function' && getCurrentView()){
        setApplicationView(getCurrentView())
    }
}

if(typeof window !== 'undefined'){
    window.AppShell = {
        routes: SHELL_ROUTES,
        navigate: navigateShellRoute,
        setLandingRoute: applyLandingRoute,
        setApplicationView,
        refreshHomeSummary,
        refreshCommunity: () => initializeCommunityHub(true),
        getRoute: () => shellRoute
    }

    if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeShell, { once: true })
    else initializeShell()
}

if(typeof module !== 'undefined'){
    module.exports = { SHELL_ROUTES, countOptionalModules }
}
