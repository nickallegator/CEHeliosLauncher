'use strict'

const SHELL_ROUTES = Object.freeze({
    home: 'home',
    community: 'community',
    packStudio: 'community/pack-studio',
    schematics: 'community',
    news: 'news',
    settings: 'settings'
})

let shellRoute = SHELL_ROUTES.home

function canonicalizeShellRoute(route){
    const requested = route === 'community/schematics' ? SHELL_ROUTES.community : route
    return Object.values(SHELL_ROUTES).includes(requested) ? requested : SHELL_ROUTES.home
}
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
    const news = document.getElementById('newsContainer')
    const schematics = document.getElementById('schematicsContainer')
    if(!landing) return

    landing.dataset.shellRoute = route
    setHidden(home, route !== SHELL_ROUTES.home)
    setHidden(news, route !== SHELL_ROUTES.news)
    setHidden(schematics, !route.startsWith('community'))
    setShellNavigationState(route)
    shellRoute = route
    window.dispatchEvent(new CustomEvent('helios:shell-route-change', { detail: { route } }))
}

async function navigateShellRoute(route){
    const next = canonicalizeShellRoute(route)

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

    if(next.startsWith('community')){
        if(newsActive) document.getElementById('newsButton')?.click()
        if(!schematicsActive) document.getElementById('schematicsButton')?.click()
        applyLandingRoute(next)
        return
    }

    if(newsActive) document.getElementById('newsButton')?.click()
    if(schematicsActive) document.getElementById('schematicsButton')?.click()
    applyLandingRoute(next)
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
        refreshCommunity: () => navigateShellRoute(SHELL_ROUTES.community),
        getRoute: () => shellRoute
    }

    if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeShell, { once: true })
    else initializeShell()
}

if(typeof module !== 'undefined'){
    module.exports = { SHELL_ROUTES, canonicalizeShellRoute, countOptionalModules }
}
