/**
 * Initialize UI functions which depend on internal modules.
 * Loaded after core UI functions are initialized in uicore.js.
 */
// Requirements
const path          = require('path')
const { Type }      = require('helios-distribution-types')
const { LoggerUtil: LoggerUtilUI } = require('helios-core')

const AuthManager   = require('./assets/js/authmanager')
const ConfigManager = require('./assets/js/configmanager')
const { DistroAPI } = require('./assets/js/distromanager')
const bundledTesterBuild = require('./assets/js/testerchannel').isTesterBuild()

const isDevDistro = process.env.HELIOS_DISTRO_DEV === '1'
const isLocalDistro = isDevDistro || bundledTesterBuild
const loggerUIBinder = LoggerUtilUI.getLogger('UIBinder')
const debugLog = (...args) => {
    const msg = args.map(v => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ')
    if(isDevDistro){
        console.log('[UIBinder]', ...args)
    }
    loggerUIBinder.info(msg)
}

let rscShouldLoad = false
let fatalStartupError = false
let distroEventHandled = false
let mainUIInitializationPromise = null

const LANDING_READY_EVENT = 'helios:landing-ready'
const LANDING_READY_TIMEOUT_MS = 15000

window.addEventListener('helios:startup-retry', () => {
    remote.getCurrentWindow().reload()
})
window.addEventListener('helios:startup-close', () => {
    remote.getCurrentWindow().close()
})

/**
 * Wait until landing.js has finished defining the functions used by this
 * binder. The distribution can finish loading while the document is still
 * being parsed, so document.readyState alone is not a sufficient readiness
 * signal.
 */
function waitForLandingReady(){
    if(window.heliosLandingReady === true){
        return Promise.resolve()
    }

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            window.removeEventListener(LANDING_READY_EVENT, onReady)
            reject(new Error('Landing UI did not initialize within the expected time.'))
        }, LANDING_READY_TIMEOUT_MS)

        const onReady = () => {
            clearTimeout(timeout)
            resolve()
        }

        window.addEventListener(LANDING_READY_EVENT, onReady, { once: true })
    })
}

// Mapping of each view to their container IDs.
const VIEWS = {
    landing: '#landingContainer',
    loginOptions: '#loginOptionsContainer',
    login: '#loginContainer',
    settings: '#settingsContainer',
    welcome: '#welcomeContainer',
    waiting: '#waitingContainer'
}

// The currently shown view container.
let currentView

/**
 * Switch launcher views.
 * 
 * @param {string} current The ID of the current view container. 
 * @param {*} next The ID of the next view container.
 * @param {*} currentFadeTime Optional. The fade out time for the current view.
 * @param {*} nextFadeTime Optional. The fade in time for the next view.
 * @param {*} onCurrentFade Optional. Callback function to execute when the current
 * view fades out.
 * @param {*} onNextFade Optional. Callback function to execute when the next view
 * fades in.
 */
async function transitionViewElement(selector, visible, requestedDuration){
    const element = document.querySelector(selector)
    if(!element) return
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
    const duration = reduceMotion ? 0 : Math.min(Number(requestedDuration) || 0, 220)
    if(visible){
        element.style.display = ''
        if(getComputedStyle(element).display === 'none') element.style.display = 'block'
    }
    if(duration > 0 && typeof element.animate === 'function'){
        const frames = visible
            ? [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }]
            : [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-4px)' }]
        try {
            await element.animate(frames, { duration, easing: 'ease-out' }).finished
        } catch(err){
            loggerUIBinder.debug('View transition was interrupted.', err?.message || err)
        }
    }
    if(!visible) element.style.display = 'none'
}

function switchView(current, next, currentFadeTime = 500, nextFadeTime = 500, onCurrentFade = () => {}, onNextFade = () => {}){
    currentView = next
    const nextUsesShell = next === VIEWS.landing || next === VIEWS.settings
    if(nextUsesShell && window.AppShell){
        window.AppShell.setApplicationView(next)
    }
    ;(async () => {
        await transitionViewElement(current, false, currentFadeTime)
        await onCurrentFade()
        if(!nextUsesShell && window.AppShell){
            window.AppShell.setApplicationView(next)
        }
        await transitionViewElement(next, true, nextFadeTime)
        await onNextFade()
    })().catch((err) => loggerUIBinder.error('Failed to switch launcher views.', err))
}

/**
 * Get the currently shown view container.
 * 
 * @returns {string} The currently shown view container.
 */
function getCurrentView(){
    return currentView
}

async function showMainUI(data){
    await waitForLandingReady()
    debugLog('showMainUI start')
    window.StartupPresentation?.setStage('account')

    if(!isDev && !testerBuild){
        loggerAutoUpdater.info('Initializing..')
        ipcRenderer.send('autoUpdateAction', 'initAutoUpdater', ConfigManager.getAllowPrerelease())
    }

    updateSelectedServer(data.getServerById(ConfigManager.getSelectedServer()))
    refreshServerStatus()
    document.getElementById('frameBar').style.backgroundColor = 'rgba(10, 18, 17, 0.98)'
    $('#main').show()

    const isLoggedIn = Object.keys(ConfigManager.getAuthAccounts()).length > 0

    // If this is enabled in a development environment we'll get ratelimited.
    // The relaunch frequency is usually far too high.
    if(!isDev && isLoggedIn){
        validateSelectedAccount()
    }

    if(ConfigManager.isFirstLaunch()){
        currentView = VIEWS.welcome
        $(VIEWS.welcome).show()
    } else {
        if(isLoggedIn){
            currentView = VIEWS.landing
            window.AppShell?.setApplicationView(VIEWS.landing)
            $(VIEWS.landing).show()
        } else {
            loginOptionsCancelEnabled(false)
            loginOptionsViewOnLoginSuccess = VIEWS.landing
            loginOptionsViewOnLoginCancel = VIEWS.loginOptions
            currentView = VIEWS.loginOptions
            $(VIEWS.loginOptions).show()
        }
    }

    window.AppShell?.setApplicationView(currentView)
    requestAnimationFrame(() => window.StartupPresentation?.markReady())
    debugLog('showMainUI end')
}

/**
 * Initialize the main UI exactly once. All startup paths (IPC, ready-state,
 * and the development fallback) converge here so they cannot race each other.
 */
async function initializeMainUI(data){
    if(mainUIInitializationPromise == null){
        mainUIInitializationPromise = showMainUI(data).catch(err => {
            fatalStartupError = true
            loggerUIBinder.error('Failed to initialize the main UI.', err)
            showFatalStartupError()
        })
    }

    await mainUIInitializationPromise
}

function showFatalStartupError(){
    window.StartupPresentation?.setFatal(
        Lang.queryJS('uibinder.startup.fatalErrorTitle'),
        Lang.queryJS('uibinder.startup.fatalErrorMessage')
    )
}

/**
 * Common functions to perform after refreshing the distro index.
 * 
 * @param {Object} data The distro index object.
 */
function onDistroRefresh(data){
    updateSelectedServer(data.getServerById(ConfigManager.getSelectedServer()))
    refreshServerStatus()
    if(typeof refreshNewsIfInitialized === 'function'){
        refreshNewsIfInitialized()
    }
    syncModConfigurations(data)
    ensureJavaSettings(data)
    window.dispatchEvent(new CustomEvent('helios:distribution-refresh', { detail: { data } }))
}

/**
 * Sync the mod configurations with the distro index.
 * 
 * @param {Object} data The distro index object.
 */
function syncModConfigurations(data){

    const syncedCfgs = []

    for(let serv of data.servers){

        const id = serv.rawServer.id
        const mdls = serv.modules
        const cfg = ConfigManager.getModConfiguration(id)

        if(cfg != null){

            const modsOld = cfg.mods
            const mods = {}

            for(let mdl of mdls){
                const type = mdl.rawModule.type

                if(type === Type.ForgeMod || type === Type.LiteMod || type === Type.LiteLoader || type === Type.FabricMod){
                    if(!mdl.getRequired().value){
                        const mdlID = mdl.getVersionlessMavenIdentifier()
                        if(modsOld[mdlID] == null){
                            mods[mdlID] = scanOptionalSubModules(mdl.subModules, mdl)
                        } else {
                            mods[mdlID] = mergeModConfiguration(modsOld[mdlID], scanOptionalSubModules(mdl.subModules, mdl), false)
                        }
                    } else {
                        if(mdl.subModules.length > 0){
                            const mdlID = mdl.getVersionlessMavenIdentifier()
                            const v = scanOptionalSubModules(mdl.subModules, mdl)
                            if(typeof v === 'object'){
                                if(modsOld[mdlID] == null){
                                    mods[mdlID] = v
                                } else {
                                    mods[mdlID] = mergeModConfiguration(modsOld[mdlID], v, true)
                                }
                            }
                        }
                    }
                }
            }

            syncedCfgs.push({
                id,
                mods
            })

        } else {

            const mods = {}

            for(let mdl of mdls){
                const type = mdl.rawModule.type
                if(type === Type.ForgeMod || type === Type.LiteMod || type === Type.LiteLoader || type === Type.FabricMod){
                    if(!mdl.getRequired().value){
                        mods[mdl.getVersionlessMavenIdentifier()] = scanOptionalSubModules(mdl.subModules, mdl)
                    } else {
                        if(mdl.subModules.length > 0){
                            const v = scanOptionalSubModules(mdl.subModules, mdl)
                            if(typeof v === 'object'){
                                mods[mdl.getVersionlessMavenIdentifier()] = v
                            }
                        }
                    }
                }
            }

            syncedCfgs.push({
                id,
                mods
            })

        }
    }

    ConfigManager.setModConfigurations(syncedCfgs)
    ConfigManager.save()
}

/**
 * Ensure java configurations are present for the available servers.
 * 
 * @param {Object} data The distro index object.
 */
function ensureJavaSettings(data) {

    // Nothing too fancy for now.
    for(const serv of data.servers){
        ConfigManager.ensureJavaConfig(serv.rawServer.id, serv.effectiveJavaOptions, serv.rawServer.javaOptions?.ram)
    }

    ConfigManager.save()
}

/**
 * Recursively scan for optional sub modules. If none are found,
 * this function returns a boolean. If optional sub modules do exist,
 * a recursive configuration object is returned.
 * 
 * @returns {boolean | Object} The resolved mod configuration.
 */
function scanOptionalSubModules(mdls, origin){
    if(mdls != null){
        const mods = {}

        for(let mdl of mdls){
            const type = mdl.rawModule.type
            // Optional types.
            if(type === Type.ForgeMod || type === Type.LiteMod || type === Type.LiteLoader || type === Type.FabricMod){
                // It is optional.
                if(!mdl.getRequired().value){
                    mods[mdl.getVersionlessMavenIdentifier()] = scanOptionalSubModules(mdl.subModules, mdl)
                } else {
                    if(mdl.hasSubModules()){
                        const v = scanOptionalSubModules(mdl.subModules, mdl)
                        if(typeof v === 'object'){
                            mods[mdl.getVersionlessMavenIdentifier()] = v
                        }
                    }
                }
            }
        }

        if(Object.keys(mods).length > 0){
            const ret = {
                mods
            }
            if(!origin.getRequired().value){
                ret.value = origin.getRequired().def
            }
            return ret
        }
    }
    return origin.getRequired().def
}

/**
 * Recursively merge an old configuration into a new configuration.
 * 
 * @param {boolean | Object} o The old configuration value.
 * @param {boolean | Object} n The new configuration value.
 * @param {boolean} nReq If the new value is a required mod.
 * 
 * @returns {boolean | Object} The merged configuration.
 */
function mergeModConfiguration(o, n, nReq = false){
    if(typeof o === 'boolean'){
        if(typeof n === 'boolean') return o
        else if(typeof n === 'object'){
            if(!nReq){
                n.value = o
            }
            return n
        }
    } else if(typeof o === 'object'){
        if(typeof n === 'boolean') return typeof o.value !== 'undefined' ? o.value : true
        else if(typeof n === 'object'){
            if(!nReq){
                n.value = typeof o.value !== 'undefined' ? o.value : true
            }

            const newMods = Object.keys(n.mods)
            for(let i=0; i<newMods.length; i++){

                const mod = newMods[i]
                if(o.mods[mod] != null){
                    n.mods[mod] = mergeModConfiguration(o.mods[mod], n.mods[mod])
                }
            }

            return n
        }
    }
    // If for some reason we haven't been able to merge,
    // wipe the old value and use the new one. Just to be safe
    return n
}

async function validateSelectedAccount(){
    const selectedAcc = ConfigManager.getSelectedAccount()
    if(selectedAcc != null){
        const val = await AuthManager.validateSelected()
        if(!val){
            ConfigManager.removeAuthAccount(selectedAcc.uuid)
            ConfigManager.save()
            const accLen = Object.keys(ConfigManager.getAuthAccounts()).length
            setOverlayContent(
                Lang.queryJS('uibinder.validateAccount.failedMessageTitle'),
                accLen > 0
                    ? Lang.queryJS('uibinder.validateAccount.failedMessage', { 'account': selectedAcc.displayName })
                    : Lang.queryJS('uibinder.validateAccount.failedMessageSelectAnotherAccount', { 'account': selectedAcc.displayName }),
                Lang.queryJS('uibinder.validateAccount.loginButton'),
                Lang.queryJS('uibinder.validateAccount.selectAnotherAccountButton')
            )
            setOverlayHandler(() => {

                const isMicrosoft = selectedAcc.type === 'microsoft'

                if(isMicrosoft) {
                    // Empty for now
                } else {
                    // Mojang
                    // For convenience, pre-populate the username of the account.
                    document.getElementById('loginUsername').value = selectedAcc.username
                    validateEmail(selectedAcc.username)
                }
                
                loginOptionsViewOnLoginSuccess = getCurrentView()
                loginOptionsViewOnLoginCancel = VIEWS.loginOptions

                if(accLen > 0) {
                    loginOptionsViewOnCancel = getCurrentView()
                    loginOptionsViewCancelHandler = () => {
                        if(isMicrosoft) {
                            ConfigManager.addMicrosoftAuthAccount(
                                selectedAcc.uuid,
                                selectedAcc.accessToken,
                                selectedAcc.username,
                                selectedAcc.expiresAt,
                                selectedAcc.microsoft.access_token,
                                selectedAcc.microsoft.refresh_token,
                                selectedAcc.microsoft.expires_at
                            )
                        } else {
                            ConfigManager.addMojangAuthAccount(selectedAcc.uuid, selectedAcc.accessToken, selectedAcc.username, selectedAcc.displayName)
                        }
                        ConfigManager.save()
                        validateSelectedAccount()
                    }
                    loginOptionsCancelEnabled(true)
                } else {
                    loginOptionsCancelEnabled(false)
                }
                toggleOverlay(false)
                switchView(getCurrentView(), VIEWS.loginOptions)
            })
            setDismissHandler(() => {
                if(accLen > 1){
                    prepareAccountSelectionList()
                    $('#overlayContent').fadeOut(250, () => {
                        bindOverlayKeys(true, 'accountSelectContent', true)
                        $('#accountSelectContent').fadeIn(250)
                    })
                } else {
                    const accountsObj = ConfigManager.getAuthAccounts()
                    const accounts = Array.from(Object.keys(accountsObj), v => accountsObj[v])
                    // This function validates the account switch.
                    setSelectedAccount(accounts[0].uuid)
                    toggleOverlay(false)
                }
            })
            toggleOverlay(true, accLen > 0)
        } else {
            try {
                const ChannelManager = require('./assets/js/channelmanager')
                if(ChannelManager.isRemoteChannel()) {
                    const refreshed = await ChannelManager.refreshAuthorizedDistribution({ allowOffline: true })
                    if(refreshed?.distribution) onDistroRefresh(refreshed.distribution)
                }
            } catch(err) {
                loggerUIBinder.warn('Unable to refresh tester channel authorization after account validation.', err.message || err)
            }
            return true
        }
    } else {
        return true
    }
}

/**
 * Temporary function to update the selected account along
 * with the relevent UI elements.
 * 
 * @param {string} uuid The UUID of the account.
 */
function setSelectedAccount(uuid){
    const authAcc = ConfigManager.setSelectedAccount(uuid)
    ConfigManager.save()
    updateSelectedAccount(authAcc)
    validateSelectedAccount()
}

// Synchronous Listener
document.addEventListener('readystatechange', async () => {

    if (document.readyState === 'interactive' || document.readyState === 'complete'){
        if(rscShouldLoad){
            rscShouldLoad = false
            if(!fatalStartupError){
                const data = await DistroAPI.getDistribution()
                await initializeMainUI(data)
            } else {
                showFatalStartupError()
            }
        } 
    }

}, false)

// Actions that must be performed after the distribution index is downloaded.
ipcRenderer.on('distributionIndexDone', async (event, res) => {
    if(distroEventHandled){
        return
    }
    distroEventHandled = true
    debugLog('distributionIndexDone', res, 'readyState', document.readyState)
    if(res) {
        const data = await DistroAPI.getDistribution()
        syncModConfigurations(data)
        ensureJavaSettings(data)
        if(document.readyState === 'interactive' || document.readyState === 'complete'){
            await initializeMainUI(data)
        } else {
            rscShouldLoad = true
        }
    } else {
        fatalStartupError = true
        if(document.readyState === 'interactive' || document.readyState === 'complete'){
            showFatalStartupError()
        } else {
            rscShouldLoad = true
        }
    }
})

// The preload can complete before this page script is evaluated. Announce
// listener readiness so the main process can replay an already-cached result.
window.StartupPresentation?.setStage('distribution')
ipcRenderer.send('distributionIndexReady')

// Local-distribution fallback for development and self-contained tester builds.
if(isLocalDistro) {
    setTimeout(async () => {
        if(distroEventHandled) {
            return
        }
        debugLog('distributionIndexDone missed, falling back to direct load')
        try {
            const data = await DistroAPI.getDistribution()
            syncModConfigurations(data)
            ensureJavaSettings(data)
            if(document.readyState === 'interactive' || document.readyState === 'complete'){
                await initializeMainUI(data)
            } else {
                rscShouldLoad = true
            }
        } catch (err) {
            debugLog('fallback distro load failed')
            console.error('[UIBinder] fallback distro load failed', err)
            fatalStartupError = true
            if(document.readyState === 'interactive' || document.readyState === 'complete'){
                showFatalStartupError()
            } else {
                rscShouldLoad = true
            }
        }
    }, 250)
}

// Util for development
async function devModeToggle() {
    DistroAPI.toggleDevMode(true)
    const data = await DistroAPI.refreshDistributionOrFallback()
    ensureJavaSettings(data)
    updateSelectedServer(data.servers[0])
    syncModConfigurations(data)
}
