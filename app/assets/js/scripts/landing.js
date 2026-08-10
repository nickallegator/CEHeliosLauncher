/**
 * Script for landing.ejs
 */
// Requirements
const { URL }                 = require('url')
const crypto = require('crypto')
const {
    MojangRestAPI,
    getServerStatus
}                             = require('helios-core/mojang')
const {
    RestResponseStatus,
    isDisplayableError,
    validateLocalFile
}                             = require('helios-core/common')
const {
    FullRepair,
    DistributionIndexProcessor,
    MojangIndexProcessor,
    downloadFile
}                             = require('helios-core/dl')
const {
    validateSelectedJvm,
    ensureJavaDirIsRoot,
    javaExecFromRoot,
    discoverBestJvmInstallation,
    latestOpenJDK,
    extractJdk
}                             = require('helios-core/java')

// Internal Requirements
const DiscordWrapper          = require('./assets/js/discordwrapper')
const ProcessBuilder          = require('./assets/js/processbuilder')
const AccessGate              = require('./assets/js/accessmanager')
const ChannelManager          = require('./assets/js/channelmanager')
const { completeJavaSelection } = require('./assets/js/javalaunchworkflow')
const { seedBundledArtifacts } = require('./assets/js/testerchannel')
const { quarantineManagedDropins } = require('./assets/js/managedmodcleanup')
const { isArtifactAuthorizationError } = require('./assets/js/channelpolicy')

// Launch Elements
const launch_content          = document.getElementById('launch_content')
const launch_details          = document.getElementById('launch_details')
const launch_progress         = document.getElementById('launch_progress')
const launch_progress_label   = document.getElementById('launch_progress_label')
const launch_details_text     = document.getElementById('launch_details_text')
const server_selection_button = document.getElementById('server_selection_button')
const user_text               = document.getElementById('user_text')

const loggerLanding = LoggerUtil.getLogger('Landing')
let settingsReadyPromise = null

async function ensureSettingsScriptLoaded(){
    if(typeof prepareSettings === 'function'){
        return
    }
    if(!settingsReadyPromise){
        settingsReadyPromise = loadLazyScript('./assets/js/scripts/settings.js')
            .catch((err) => {
                settingsReadyPromise = null
                throw err
            })
    }
    await settingsReadyPromise
    if(typeof prepareSettings !== 'function'){
        throw new Error('Settings script loaded without prepareSettings.')
    }
}

async function ensureSettingsReady(){
    await ensureSettingsScriptLoaded()
    await prepareSettings()
}

/* Launch Progress Wrapper Functions */

/**
 * Show/hide the loading area.
 * 
 * @param {boolean} loading True if the loading area should be shown, otherwise false.
 */
function toggleLaunchArea(loading){
    if(loading){
        launch_details.style.display = 'flex'
        launch_content.style.display = 'none'
    } else {
        launch_details.style.display = 'none'
        launch_content.style.display = 'inline-flex'
    }
}

/**
 * Set the details text of the loading area.
 * 
 * @param {string} details The new text for the loading details.
 */
function setLaunchDetails(details){
    launch_details_text.innerHTML = details
}

/**
 * Set the value of the loading progress bar and display that value.
 * 
 * @param {number} percent Percentage (0-100)
 */
function setLaunchPercentage(percent){
    launch_progress.setAttribute('max', 100)
    launch_progress.setAttribute('value', percent)
    launch_progress_label.innerHTML = percent + '%'
}

/**
 * Set the value of the OS progress bar and display that on the UI.
 * 
 * @param {number} percent Percentage (0-100)
 */
function setDownloadPercentage(percent){
    remote.getCurrentWindow().setProgressBar(percent/100)
    setLaunchPercentage(percent)
}

/**
 * Enable or disable the launch button.
 * 
 * @param {boolean} val True to enable, false to disable.
 */
function setLaunchEnabled(val){
    document.getElementById('launch_button').disabled = !val
}

// Bind launch button
document.getElementById('launch_button').addEventListener('click', async e => {
    loggerLanding.info('Launching game..')
    try {
        if(ChannelManager.isRemoteChannel()) {
            const authorized = await ChannelManager.refreshAuthorizedDistribution({ allowOffline: true })
            if(authorized?.distribution) onDistroRefresh(authorized.distribution)
        }
        const server = (await DistroAPI.getDistribution()).getServerById(ConfigManager.getSelectedServer())
        const jExe = ConfigManager.getJavaExecutable(ConfigManager.getSelectedServer())
        if(jExe == null){
            await asyncSystemScan(server.effectiveJavaOptions)
        } else {

            setLaunchDetails(Lang.queryJS('landing.launch.pleaseWait'))
            toggleLaunchArea(true)
            setLaunchPercentage(0, 100)

            const details = await validateSelectedJvm(ensureJavaDirIsRoot(jExe), server.effectiveJavaOptions.supported)
            if(details != null){
                loggerLanding.info('Jvm Details', details)
                await dlAsync()

            } else {
                await asyncSystemScan(server.effectiveJavaOptions)
            }
        }
    } catch(err) {
        loggerLanding.error('Unhandled error during launch process.', { code: err?.code, statusCode: err?.statusCode, message: err?.message })
        showLaunchFailure(Lang.queryJS('landing.launch.failureTitle'), err?.message || Lang.queryJS('landing.launch.failureText'))
    }
})

// Bind settings button
document.getElementById('settingsMediaButton').onclick = async e => {
    try {
        await ensureSettingsReady()
        switchView(getCurrentView(), VIEWS.settings)
    } catch (err) {
        loggerLanding.warn('Failed to initialize settings view.', err)
    }
}

// Bind avatar overlay button.
document.getElementById('avatarOverlay').onclick = async e => {
    try {
        await ensureSettingsReady()
        switchView(getCurrentView(), VIEWS.settings, 500, 500, () => {
            settingsNavItemListener(document.getElementById('settingsNavAccount'), false)
        })
    } catch (err) {
        loggerLanding.warn('Failed to initialize settings view.', err)
    }
}

// Bind selected account
function updateSelectedAccount(authUser){
    let username = Lang.queryJS('landing.selectedAccount.noAccountSelected')
    if(authUser != null){
        if(authUser.displayName != null){
            username = authUser.displayName
        }
        if(authUser.uuid != null){
            document.getElementById('avatarContainer').style.backgroundImage = `url('https://mc-heads.net/body/${authUser.uuid}/right')`
        }
    }
    user_text.innerHTML = username
}
updateSelectedAccount(ConfigManager.getSelectedAccount())

// Bind selected server
function updateSelectedServer(serv){
    if(getCurrentView() === VIEWS.settings){
        fullSettingsSave()
    }
    ConfigManager.setSelectedServer(serv != null ? serv.rawServer.id : null)
    ConfigManager.save()
    server_selection_button.innerHTML = '&#8226; ' + (serv != null ? serv.rawServer.name : Lang.queryJS('landing.noSelection'))
    if(getCurrentView() === VIEWS.settings){
        animateSettingsTabRefresh()
    }
    setLaunchEnabled(serv != null)
}
// Real text is set in uibinder.js on distributionIndexDone.
server_selection_button.innerHTML = '&#8226; ' + Lang.queryJS('landing.selectedServer.loading')
server_selection_button.onclick = async e => {
    e.target.blur()
    await toggleServerSelection(true)
}

// Update Mojang Status Color
const refreshMojangStatuses = async function(){
    loggerLanding.info('Refreshing Mojang Statuses..')

    let status = 'grey'
    let tooltipEssentialHTML = ''
    let tooltipNonEssentialHTML = ''

    const response = await MojangRestAPI.status()
    let statuses
    if(response.responseStatus === RestResponseStatus.SUCCESS) {
        statuses = response.data
    } else {
        loggerLanding.warn('Unable to refresh Mojang service status.')
        statuses = MojangRestAPI.getDefaultStatuses()
    }
    
    greenCount = 0
    greyCount = 0

    for(let i=0; i<statuses.length; i++){
        const service = statuses[i]

        const tooltipHTML = `<div class="mojangStatusContainer">
            <span class="mojangStatusIcon" style="color: ${MojangRestAPI.statusToHex(service.status)};">&#8226;</span>
            <span class="mojangStatusName">${service.name}</span>
        </div>`
        if(service.essential){
            tooltipEssentialHTML += tooltipHTML
        } else {
            tooltipNonEssentialHTML += tooltipHTML
        }

        if(service.status === 'yellow' && status !== 'red'){
            status = 'yellow'
        } else if(service.status === 'red'){
            status = 'red'
        } else {
            if(service.status === 'grey'){
                ++greyCount
            }
            ++greenCount
        }

    }

    if(greenCount === statuses.length){
        if(greyCount === statuses.length){
            status = 'grey'
        } else {
            status = 'green'
        }
    }
    
    document.getElementById('mojangStatusEssentialContainer').innerHTML = tooltipEssentialHTML
    document.getElementById('mojangStatusNonEssentialContainer').innerHTML = tooltipNonEssentialHTML
    document.getElementById('mojang_status_icon').style.color = MojangRestAPI.statusToHex(status)
}

const refreshServerStatus = async (fade = false) => {
    loggerLanding.info('Refreshing Server Status')
    const serv = (await DistroAPI.getDistribution()).getServerById(ConfigManager.getSelectedServer())

    let pLabel = Lang.queryJS('landing.serverStatus.server')
    let pVal = Lang.queryJS('landing.serverStatus.offline')

    try {

        const servStat = await getServerStatus(47, serv.hostname, serv.port)
        console.log(servStat)
        pLabel = Lang.queryJS('landing.serverStatus.players')
        pVal = servStat.players.online + '/' + servStat.players.max

    } catch (err) {
        loggerLanding.warn('Unable to refresh server status, assuming offline.')
        loggerLanding.debug(err)
    }
    if(fade){
        $('#server_status_wrapper').fadeOut(250, () => {
            document.getElementById('landingPlayerLabel').innerHTML = pLabel
            document.getElementById('player_count').innerHTML = pVal
            $('#server_status_wrapper').fadeIn(500)
        })
    } else {
        document.getElementById('landingPlayerLabel').innerHTML = pLabel
        document.getElementById('player_count').innerHTML = pVal
    }
    
}

refreshMojangStatuses()
// Server Status is refreshed in uibinder.js on distributionIndexDone.

// Refresh statuses every hour. The status page itself refreshes every day so...
let mojangStatusListener = setInterval(() => refreshMojangStatuses(true), 60*60*1000)
// Set refresh rate to once every 5 minutes.
let serverStatusListener = setInterval(() => refreshServerStatus(true), 300000)

/**
 * Shows an error overlay, toggles off the launch area.
 * 
 * @param {string} title The overlay title.
 * @param {string} desc The overlay description.
 */
function showLaunchFailure(title, desc){
    setOverlayContent(
        title,
        desc,
        Lang.queryJS('landing.launch.okay')
    )
    setOverlayHandler(null)
    toggleOverlay(true)
    toggleLaunchArea(false)
}

/* System (Java) Scan */

/**
 * Persist a validated Java installation and refresh the settings view only
 * when its lazily loaded controller is already available. The launch path
 * must not depend on opening Settings first.
 */
async function useJavaInstallation(jvmDetails, launchAfter){
    await completeJavaSelection({
        jvmDetails,
        javaExecFromRoot,
        serverId: ConfigManager.getSelectedServer(),
        setJavaExecutable: (serverId, javaExec) => ConfigManager.setJavaExecutable(serverId, javaExec),
        saveConfig: () => ConfigManager.save(),
        settingsInput: document.getElementById('settingsJavaExecVal'),
        populateJavaDetails: typeof populateJavaExecDetails === 'function' ? populateJavaExecDetails : null,
        launchAfter,
        launch: dlAsync
    })
}

function showJavaDownloadFailure(err){
    loggerLanding.error('Unhandled error in Java download.', err)
    showLaunchFailure(
        Lang.queryJS('landing.systemScan.javaDownloadFailureTitle'),
        Lang.queryJS('landing.systemScan.javaDownloadFailureText')
    )
}

/**
 * Asynchronously scan the system for valid Java installations.
 * 
 * @param {boolean} launchAfter Whether we should begin to launch after scanning. 
 */
async function asyncSystemScan(effectiveJavaOptions, launchAfter = true){

    setLaunchDetails(Lang.queryJS('landing.systemScan.checking'))
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    const jvmDetails = await discoverBestJvmInstallation(
        ConfigManager.getDataDirectory(),
        effectiveJavaOptions.supported
    )

    if(jvmDetails == null) {
        // If the result is null, no valid Java installation was found.
        // Show this information to the user.
        setOverlayContent(
            Lang.queryJS('landing.systemScan.noCompatibleJava'),
            Lang.queryJS('landing.systemScan.installJavaMessage', { 'major': effectiveJavaOptions.suggestedMajor }),
            Lang.queryJS('landing.systemScan.installJava'),
            Lang.queryJS('landing.systemScan.installJavaManually')
        )
        setOverlayHandler(async () => {
            setLaunchDetails(Lang.queryJS('landing.systemScan.javaDownloadPrepare'))
            toggleOverlay(false)

            try {
                await downloadJava(effectiveJavaOptions, launchAfter)
            } catch(err) {
                showJavaDownloadFailure(err)
            }
        })
        setDismissHandler(() => {
            $('#overlayContent').fadeOut(250, () => {
                //$('#overlayDismiss').toggle(false)
                setOverlayContent(
                    Lang.queryJS('landing.systemScan.javaRequired', { 'major': effectiveJavaOptions.suggestedMajor }),
                    Lang.queryJS('landing.systemScan.javaRequiredMessage', { 'major': effectiveJavaOptions.suggestedMajor }),
                    Lang.queryJS('landing.systemScan.javaRequiredDismiss'),
                    Lang.queryJS('landing.systemScan.javaRequiredCancel')
                )
                setOverlayHandler(() => {
                    toggleLaunchArea(false)
                    toggleOverlay(false)
                })
                setDismissHandler(async () => {
                    toggleOverlay(false, true)
                    try {
                        await asyncSystemScan(effectiveJavaOptions, launchAfter)
                    } catch(err) {
                        showJavaDownloadFailure(err)
                    }
                })
                $('#overlayContent').fadeIn(250)
            })
        })
        toggleOverlay(true, true)
    } else {
        await useJavaInstallation(jvmDetails, launchAfter)
    }

}

async function downloadJava(effectiveJavaOptions, launchAfter = true) {
    let extractListener = null

    try {
        const asset = await latestOpenJDK(
            effectiveJavaOptions.suggestedMajor,
            ConfigManager.getDataDirectory(),
            effectiveJavaOptions.distribution)

        if(asset == null) {
            throw new Error(Lang.queryJS('landing.downloadJava.findJdkFailure'))
        }

        let received = 0
        await downloadFile(asset.url, asset.path, ({ transferred }) => {
            received = transferred
            setDownloadPercentage(Math.trunc((transferred/asset.size)*100))
        })
        setDownloadPercentage(100)

        if(received !== asset.size) {
            loggerLanding.warn(`Java Download: Expected ${asset.size} bytes but received ${received}`)
        }
        if(!await validateLocalFile(asset.path, asset.algo, asset.hash)) {
            loggerLanding.error(`Hashes do not match, ${asset.id} may be corrupted.`)
            throw new Error(Lang.queryJS('landing.downloadJava.javaDownloadCorruptedError'))
        }

        remote.getCurrentWindow().setProgressBar(2)

        const extractingLabel = Lang.queryJS('landing.downloadJava.extractingJava')
        let dotStr = ''
        setLaunchDetails(extractingLabel)
        extractListener = setInterval(() => {
            if(dotStr.length >= 3){
                dotStr = ''
            } else {
                dotStr += '.'
            }
            setLaunchDetails(extractingLabel + dotStr)
        }, 750)

        const newJavaExec = await extractJdk(asset.path)
        const jvmDetails = await validateSelectedJvm(
            ensureJavaDirIsRoot(newJavaExec),
            effectiveJavaOptions.supported
        )
        if(jvmDetails == null){
            throw new Error('The installed Java runtime does not satisfy the selected profile.')
        }

        clearInterval(extractListener)
        extractListener = null
        setLaunchDetails(Lang.queryJS('landing.downloadJava.javaInstalled'))
        await useJavaInstallation(jvmDetails, launchAfter)
    } finally {
        if(extractListener != null){
            clearInterval(extractListener)
        }
        remote.getCurrentWindow().setProgressBar(-1)
    }

}

// Keep reference to Minecraft Process
let proc
// Is DiscordRPC enabled
let hasRPC = false
// Joined server regex
// Change this if your server uses something different.
const GAME_JOINED_REGEX = /\[.+\]: Sound engine started/
const GAME_LAUNCH_REGEX = /^\[.+\]: (?:MinecraftForge .+ Initialized|NeoForge .+ Initialized|ModLauncher .+ starting: .+|Loading Minecraft .+ with Fabric Loader .+)$/
const MIN_LINGER = 5000

async function dlAsync(login = true) {

    // Login parameter is temporary for debug purposes. Allows testing the validation/downloads without
    // launching the game.

    const loggerLaunchSuite = LoggerUtil.getLogger('LaunchSuite')

    try {
        seedBundledArtifacts(ConfigManager.getDataDirectory())
    } catch(err) {
        loggerLaunchSuite.error('Unable to install bundled tester artifacts.', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.fatalError'), err.message)
        return
    }

    setLaunchDetails(Lang.queryJS('landing.dlAsync.loadingServerInfo'))

    let distro
    let channelOffline = false

    try {
        if(ChannelManager.isRemoteChannel()) {
            const channelResult = await ChannelManager.refreshAuthorizedDistribution({ allowOffline: true })
            distro = channelResult.distribution
            channelOffline = channelResult.offline
        } else {
            distro = await DistroAPI.refreshDistributionOrFallback()
        }
        onDistroRefresh(distro)
    } catch(err) {
        loggerLaunchSuite.error('Unable to refresh distribution index.', { code: err?.code, statusCode: err?.statusCode, message: err?.message })
        showLaunchFailure(
            Lang.queryJS('landing.dlAsync.fatalError'),
            err?.message || Lang.queryJS('landing.dlAsync.unableToLoadDistributionIndex')
        )
        return
    }

    await AccessGate.refreshEntitlements(distro)
    const accessEntitlements = AccessGate.getEntitlements()

    let serv = distro.getServerById(ConfigManager.getSelectedServer())

    if(login) {
        if(ConfigManager.getSelectedAccount() == null){
            loggerLanding.error('You must be logged into an account.')
            return
        }
    }

    setLaunchDetails(Lang.queryJS('landing.dlAsync.pleaseWait'))
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    async function repairOnce(currentDistro, offline) {
        const repair = new FullRepair(
            ConfigManager.getCommonDirectory(),
            ConfigManager.getInstanceDirectory(),
            ConfigManager.getLauncherDirectory(),
            ConfigManager.getSelectedServer(),
            DistroAPI.isDevMode(),
            accessEntitlements
        )
        repair.spawnReceiver()
        const repairChild = repair.childProcess
        repairChild.on('error', err => loggerLaunchSuite.error('Repair process error.', err?.message || err))
        try {
            loggerLaunchSuite.info('Validating files.')
            setLaunchDetails(Lang.queryJS('landing.dlAsync.validatingFileIntegrity'))
            const invalidFileCount = await repair.verifyFiles(percent => setLaunchPercentage(percent))
            setLaunchPercentage(100)
            if(invalidFileCount > 0 && offline) {
                const error = new Error('The release service is offline and one or more game files are missing or corrupt. Connect to the internet to repair this installation.')
                error.code = 'offline_repair_required'
                throw error
            }
            if(invalidFileCount > 0) {
                loggerLaunchSuite.info('Downloading files.')
                setLaunchDetails(Lang.queryJS('landing.dlAsync.downloadingFiles'))
                setLaunchPercentage(0)
                await repair.download(percent => setDownloadPercentage(percent))
                setDownloadPercentage(100)
            } else {
                loggerLaunchSuite.info('No invalid files, skipping download.')
            }
            return currentDistro
        } finally {
            try { repair.destroyReceiver() } catch(err) { /* receiver already closed */ }
            if(repairChild && repairChild.exitCode == null) {
                try { repairChild.kill() } catch(err) { /* already exiting */ }
            }
        }
    }

    try {
        distro = await repairOnce(distro, channelOffline)
    } catch(err) {
        const detail = String(err?.displayable || err?.message || '')
        const signedUrlExpired = ChannelManager.isRemoteChannel() && isArtifactAuthorizationError(err)
        if(signedUrlExpired) {
            loggerLaunchSuite.warn('A signed artifact URL expired; refreshing authorization and retrying the complete repair once.')
            try {
                const refreshed = await ChannelManager.refreshAuthorizedDistribution({ allowOffline: false })
                distro = refreshed.distribution
                onDistroRefresh(distro)
                distro = await repairOnce(distro, false)
            } catch(retryError) {
                loggerLaunchSuite.error('Repair retry failed.', retryError)
                showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileDownloadTitle'), retryError?.displayable || retryError?.message || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
                return
            }
        } else {
            loggerLaunchSuite.error('Error during file repair.', err)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileVerificationTitle'), detail || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
            return
        }
    }

    serv = distro.getServerById(ConfigManager.getSelectedServer())
    if(ChannelManager.isRemoteChannel()) {
        const quarantined = quarantineManagedDropins(
            ConfigManager.getInstanceDirectory(),
            serv.rawServer.id,
            serv.rawServer.minecraftVersion
        )
        if(quarantined.length > 0) {
            loggerLaunchSuite.info(`Quarantined ${quarantined.length} unmanaged Cobble Power JAR(s) from the active mods directory.`)
        }
    }

    // Remove download bar.
    remote.getCurrentWindow().setProgressBar(-1)

    setLaunchDetails(Lang.queryJS('landing.dlAsync.preparingToLaunch'))

    const mojangIndexProcessor = new MojangIndexProcessor(
        ConfigManager.getCommonDirectory(),
        serv.rawServer.minecraftVersion)
    const distributionIndexProcessor = new DistributionIndexProcessor(
        ConfigManager.getCommonDirectory(),
        distro,
        serv.rawServer.id,
        accessEntitlements
    )

    const javaExec = ConfigManager.getJavaExecutable(ConfigManager.getSelectedServer())
    if(javaExec != null){
        process.env.HELIOS_JAVA_EXEC = javaExec
    }
    const modLoaderData = await distributionIndexProcessor.loadModLoaderVersionJson(serv)
    const versionData = await mojangIndexProcessor.getVersionJson()

    if(login) {
        const authUser = ConfigManager.getSelectedAccount()
        loggerLaunchSuite.info(`Sending selected account (${authUser.displayName}) to ProcessBuilder.`)
        let pb = new ProcessBuilder(serv, versionData, modLoaderData, authUser, remote.app.getVersion())
        setLaunchDetails(Lang.queryJS('landing.dlAsync.launchingGame'))

        // const SERVER_JOINED_REGEX = /\[.+\]: \[CHAT\] [a-zA-Z0-9_]{1,16} joined the game/
        const SERVER_JOINED_REGEX = new RegExp(`\\[.+\\]: \\[CHAT\\] ${authUser.displayName} joined the game`)

        const onLoadComplete = () => {
            toggleLaunchArea(false)
            if(hasRPC){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.loading'))
                proc.stdout.on('data', gameStateChange)
            }
            proc.stdout.removeListener('data', tempListener)
            proc.stderr.removeListener('data', gameErrorListener)
        }
        const start = Date.now()

        // Attach a temporary listener to the client output.
        // Will wait for a certain bit of text meaning that
        // the client application has started, and we can hide
        // the progress bar stuff.
        const tempListener = function(data){
            if(GAME_LAUNCH_REGEX.test(data.trim())){
                const diff = Date.now()-start
                if(diff < MIN_LINGER) {
                    setTimeout(onLoadComplete, MIN_LINGER-diff)
                } else {
                    onLoadComplete()
                }
            }
        }

        // Listener for Discord RPC.
        const gameStateChange = function(data){
            data = data.trim()
            if(SERVER_JOINED_REGEX.test(data)){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.joined'))
            } else if(GAME_JOINED_REGEX.test(data)){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.joining'))
            }
        }

        const gameErrorListener = function(data){
            data = data.trim()
            if(data.indexOf('Could not find or load main class net.minecraft.launchwrapper.Launch') > -1){
                loggerLaunchSuite.error('Game launch failed, LaunchWrapper was not downloaded properly.')
                showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.launchWrapperNotDownloaded'))
            }
        }

        try {
            // Build Minecraft process.
            proc = pb.build()

            // Bind listeners to stdout.
            proc.stdout.on('data', tempListener)
            proc.stderr.on('data', gameErrorListener)

            setLaunchDetails(Lang.queryJS('landing.dlAsync.doneEnjoyServer'))

            // Init Discord Hook
            if(distro.rawDistribution.discord != null && serv.rawServer.discord != null){
                DiscordWrapper.initRPC(distro.rawDistribution.discord, serv.rawServer.discord)
                hasRPC = true
                proc.on('close', (code, signal) => {
                    loggerLaunchSuite.info('Shutting down Discord Rich Presence..')
                    DiscordWrapper.shutdownRPC()
                    hasRPC = false
                    proc = null
                })
            }

        } catch(err) {

            loggerLaunchSuite.error('Error during launch', err)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.checkConsoleForDetails'))

        }
    }

}

/**
 * News Loading Functions
 */

// DOM Cache
const newsContainer                 = document.getElementById('newsContainer')
const newsContent                   = document.getElementById('newsContent')
const newsArticleTitle              = document.getElementById('newsArticleTitle')
const newsArticleDate               = document.getElementById('newsArticleDate')
const newsArticleAuthor             = document.getElementById('newsArticleAuthor')
const newsArticleComments           = document.getElementById('newsArticleComments')
const newsNavigationStatus          = document.getElementById('newsNavigationStatus')
const newsArticleContentScrollable  = document.getElementById('newsArticleContentScrollable')
const nELoadSpan                    = document.getElementById('nELoadSpan')
const topActions                    = document.getElementById('topActions')

logLandingTemplateStatus()

// News slide caches.
let newsActive = false
let schematicsActive = false
let landingOverlayGlideCount = 0
let newsInitialized = false
let newsInitPromise = null
let schematicsReadyPromise = null
let schematicsInitialized = false

const SCHEMATICS_LAZY_SCRIPT_PATHS = [
    './assets/js/scripts/landing/schematics/core.js',
    './assets/js/scripts/landing/schematics/api.js',
    './assets/js/scripts/landing/schematics/admin.js',
    './assets/js/scripts/landing/schematics/preview.js',
    './assets/js/scripts/landing/schematics/render.js',
    './assets/js/scripts/landing/schematics/creator.js',
    './assets/js/scripts/landing/schematics/collections.js',
    './assets/js/scripts/landing/schematics/upload.js',
    './assets/js/scripts/landing/schematics/edit.js',
    './assets/js/scripts/landing/schematics/detail.js',
    './assets/js/scripts/landing/schematics/index.js'
]

const landingUpperSection = document.querySelector('#landingContainer > #upper')
const landingLowerLeftSection = document.querySelector('#landingContainer > #lower > #left')
const landingLowerCenterSection = document.querySelector('#landingContainer > #lower > #center')
const landingLowerRightSection = document.querySelector('#landingContainer > #lower > #right')

function setElementInertState(element, inert){
    if(!element){
        return
    }
    if('inert' in element){
        element.inert = inert
    }
    element.setAttribute('aria-hidden', inert ? 'true' : 'false')
}

function updateOverlayAccessibility(mode = 'landing'){
    const overlayMode = mode === 'news' || mode === 'schematics' ? mode : 'landing'
    const showNews = overlayMode === 'news'
    const showSchematics = overlayMode === 'schematics'
    const overlayOpen = showNews || showSchematics

    setElementInertState(newsContainer, !showNews)
    setElementInertState(schematicsContainer, !showSchematics)
    setElementInertState(landingUpperSection, overlayOpen)
    setElementInertState(landingLowerLeftSection, overlayOpen)
    setElementInertState(landingLowerRightSection, overlayOpen)
    setElementInertState(landingLowerCenterSection, false)
    setElementInertState(topActions, false)
}

function loadLazyScript(src){
    return new Promise((resolve, reject) => {
        const selector = `script[data-lazy-src="${src}"]`
        const existing = document.querySelector(selector)
        if(existing){
            if(existing.getAttribute('data-loaded') === 'true'){
                resolve()
                return
            }
            existing.addEventListener('load', () => resolve(), { once: true })
            existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true })
            return
        }

        const script = document.createElement('script')
        script.src = src
        script.defer = true
        script.setAttribute('data-lazy-src', src)
        script.onload = () => {
            script.setAttribute('data-loaded', 'true')
            resolve()
        }
        script.onerror = () => {
            reject(new Error(`Failed to load ${src}`))
        }
        document.body.appendChild(script)
    })
}

async function ensureSchematicsReady(){
    if(schematicsInitialized && typeof initSchematics === 'function'){
        return
    }
    if(!schematicsReadyPromise){
        schematicsReadyPromise = (async () => {
            for(const scriptPath of SCHEMATICS_LAZY_SCRIPT_PATHS){
                await loadLazyScript(scriptPath)
            }
            if(typeof initSchematics === 'function' && !schematicsInitialized){
                initSchematics()
                schematicsInitialized = true
            }
        })().catch((err) => {
            schematicsReadyPromise = null
            throw err
        })
    }
    await schematicsReadyPromise
}

async function ensureNewsInitialized({ force = false } = {}){
    if(force){
        newsInitPromise = null
        newsInitialized = false
    }
    if(newsInitialized && !force){
        return
    }
    if(!newsInitPromise){
        newsInitPromise = initNews()
            .then(() => {
                newsInitialized = true
            })
            .finally(() => {
                newsInitPromise = null
            })
    }
    await newsInitPromise
}

function refreshNewsIfInitialized(){
    if(!newsInitialized){
        return
    }
    ensureNewsInitialized({ force: true })
        .catch((err) => {
            loggerLanding.warn('Failed to refresh news.', err)
        })
}

/**
 * Show the news UI via a slide animation.
 * 
 * @param {HTMLElement} container The overlay container to slide.
 * @param {boolean} up True to slide up, otherwise false. 
 */
function slide_(container, up){
    const lCUpper = document.querySelector('#landingContainer > #upper')
    const lCLLeft = document.querySelector('#landingContainer > #lower > #left')
    const lCLCenter = document.querySelector('#landingContainer > #lower > #center')
    const lCLRight = document.querySelector('#landingContainer > #lower > #right')
    const centerContent = document.querySelector('#landingContainer > #lower > #center #content')
    const landingContainer = document.getElementById('landingContainer')
    const overlayContainers = [newsContainer, schematicsContainer]
    const isNews = container === newsContainer
    const isSchematics = container === schematicsContainer
    const moveDown = isNews

    landingOverlayGlideCount++

    if(up){
        const offscreen = moveDown ? '200vh' : '-200vh'
        const communityOffset = '-72vh'
        if(landingContainer){
            if(isNews){
                landingContainer.setAttribute('data-overlay', 'news')
            } else if(isSchematics){
                landingContainer.setAttribute('data-overlay', 'schematics')
            } else {
                landingContainer.removeAttribute('data-overlay')
            }
        }
        overlayContainers.forEach((overlay) => {
            if(overlay && overlay !== container){
                hideOverlay(overlay)
            }
        })
        if(topActions){
            if(isNews){
                topActions.style.top = 'calc(100% - 60px)'
            } else if(isSchematics){
                topActions.style.top = offscreen
            } else {
                topActions.style.top = '18px'
            }
        }
        lCUpper.style.top = offscreen
        lCLLeft.style.top = offscreen
        lCLCenter.style.top = isSchematics ? communityOffset : offscreen
        lCLRight.style.top = offscreen
        centerContent.style.top = isSchematics ? '-8px' : '130vh'
        if(lCLCenter){
            lCLCenter.style.zIndex = isSchematics ? '650' : ''
        }
        container.style.top = '22px'
        //date.toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric'})
        //landingContainer.style.background = 'rgba(29, 29, 29, 0.55)'
        landingContainer.style.background = 'rgba(0, 0, 0, 0.50)'
        setTimeout(() => {
            if(landingOverlayGlideCount === 1){
                lCLCenter.style.transition = 'none'
                centerContent.style.transition = 'none'
            }
            landingOverlayGlideCount--
        }, 2000)
    } else {
        setTimeout(() => {
            landingOverlayGlideCount--
        }, 2000)
        if(landingContainer){
            landingContainer.removeAttribute('data-overlay')
        }
        landingContainer.style.background = null
        lCLCenter.style.transition = null
        centerContent.style.transition = null
        hideOverlay(container)
        lCUpper.style.top = '0px'
        lCLLeft.style.top = '0px'
        lCLCenter.style.top = '0px'
        lCLRight.style.top = '0px'
        if(topActions){
            topActions.style.top = '18px'
        }
        if(lCLCenter){
            lCLCenter.style.zIndex = ''
        }
        centerContent.style.top = '4px'
    }
}

function getOverlayHiddenTop(container){
    return container === newsContainer ? '-100%' : '100%'
}

function hideOverlay(container){
    if(container){
        container.style.top = getOverlayHiddenTop(container)
    }
}

function enableOverlayTabbing(containerSelector){
    if(containerSelector === '#newsContainer'){
        updateOverlayAccessibility('news')
        return
    }
    if(containerSelector === '#schematicsContainer'){
        updateOverlayAccessibility('schematics')
        return
    }
    updateOverlayAccessibility('landing')
}

function resetOverlayTabbing(){
    updateOverlayAccessibility('landing')
}

updateOverlayAccessibility('landing')

// Bind news button.
document.getElementById('newsButton').onclick = () => {
    // Toggle tabbing.
    if(newsActive){
        resetOverlayTabbing()
        slide_(newsContainer, false)
        newsActive = false
    } else {
        if(schematicsActive){
            schematicsActive = false
            hideOverlay(schematicsContainer)
            if(typeof closeSchematicDetail === 'function'){
                closeSchematicDetail()
            }
        }
        enableOverlayTabbing('#newsContainer')
        if(newsAlertShown){
            $('#newsButtonAlert').fadeOut(2000)
            newsAlertShown = false
            ConfigManager.setNewsCacheDismissed(true)
            ConfigManager.save()
        }
        slide_(newsContainer, true)
        newsActive = true
        ensureNewsInitialized().catch((err) => {
            loggerLanding.warn('Failed to initialize news.', err)
        })
    }
}

// Bind schematics button.
document.getElementById('schematicsButton').onclick = async () => {
    if(schematicsActive){
        if(typeof closeSchematicDetail === 'function'){
            closeSchematicDetail()
        }
        resetOverlayTabbing()
        slide_(schematicsContainer, false)
        schematicsActive = false
        logOverlayState('schematicsContainer(close)', schematicsContainer)
    } else {
        if(newsActive){
            newsActive = false
            hideOverlay(newsContainer)
        }
        enableOverlayTabbing('#schematicsContainer')
        slide_(schematicsContainer, true)
        schematicsActive = true
        logOverlayState('schematicsContainer(open)', schematicsContainer)
        try {
            await ensureSchematicsReady()
            if(schematicsActive && typeof updateCommunityView === 'function'){
                updateCommunityView()
            }
        } catch (err) {
            loggerLanding.warn('Failed to initialize schematics UI.', err)
            resetOverlayTabbing()
            slide_(schematicsContainer, false)
            schematicsActive = false
        }
    }
}

// Array to store article meta.
let newsArr = null

// News load animation listener.
let newsLoadingListener = null

/**
 * Set the news loading animation.
 * 
 * @param {boolean} val True to set loading animation, otherwise false.
 */
function setNewsLoading(val){
    if(val){
        const nLStr = Lang.queryJS('landing.news.checking')
        let dotStr = '..'
        nELoadSpan.innerHTML = nLStr + dotStr
        newsLoadingListener = setInterval(() => {
            if(dotStr.length >= 3){
                dotStr = ''
            } else {
                dotStr += '.'
            }
            nELoadSpan.innerHTML = nLStr + dotStr
        }, 750)
    } else {
        if(newsLoadingListener != null){
            clearInterval(newsLoadingListener)
            newsLoadingListener = null
        }
    }
}

// Bind retry button.
newsErrorRetry.onclick = () => {
    $('#newsErrorFailed').fadeOut(250, () => {
        ensureNewsInitialized({ force: true }).catch((err) => {
            loggerLanding.warn('Failed to reload news from retry action.', err)
        })
        $('#newsErrorLoading').fadeIn(250)
    })
}

newsArticleContentScrollable.onscroll = (e) => {
    if(e.target.scrollTop > Number.parseFloat($('.newsArticleSpacerTop').css('height'))){
        newsContent.setAttribute('scrolled', '')
    } else {
        newsContent.removeAttribute('scrolled')
    }
}

/**
 * Reload the news without restarting.
 * 
 * @returns {Promise.<void>} A promise which resolves when the news
 * content has finished loading and transitioning.
 */
function reloadNews(){
    return new Promise((resolve, reject) => {
        $('#newsContent').fadeOut(250, () => {
            $('#newsErrorLoading').fadeIn(250)
            ensureNewsInitialized({ force: true }).then(() => {
                resolve()
            })
        })
    })
}

let newsAlertShown = false

/**
 * Show the news alert indicating there is new news.
 */
function showNewsAlert(){
    newsAlertShown = true
    $(newsButtonAlert).fadeIn(250)
}

async function digestMessage(str) {
    const msgUint8 = new TextEncoder().encode(str)
    const hashBuffer = await crypto.subtle.digest('SHA-1', msgUint8)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const hashHex = hashArray
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    return hashHex
}

/**
 * Initialize News UI. This will load the news and prepare
 * the UI accordingly.
 * 
 * @returns {Promise.<void>} A promise which resolves when the news
 * content has finished loading and transitioning.
 */
async function initNews(){

    setNewsLoading(true)

    const news = await loadNews()

    newsArr = news?.articles || null

    if(newsArr == null){
        // News Loading Failed
        setNewsLoading(false)

        await $('#newsErrorLoading').fadeOut(250).promise()
        await $('#newsErrorFailed').fadeIn(250).promise()

    } else if(newsArr.length === 0) {
        // No News Articles
        setNewsLoading(false)

        ConfigManager.setNewsCache({
            date: null,
            content: null,
            dismissed: false
        })
        ConfigManager.save()

        await $('#newsErrorLoading').fadeOut(250).promise()
        await $('#newsErrorNone').fadeIn(250).promise()
    } else {
        // Success
        setNewsLoading(false)

        const lN = newsArr[0]
        const cached = ConfigManager.getNewsCache()
        let newHash = await digestMessage(lN.content)
        let newDate = new Date(lN.date)
        let isNew = false

        if(cached.date != null && cached.content != null){

            if(new Date(cached.date) >= newDate){

                // Compare Content
                if(cached.content !== newHash){
                    isNew = true
                    showNewsAlert()
                } else {
                    if(!cached.dismissed){
                        isNew = true
                        showNewsAlert()
                    }
                }

            } else {
                isNew = true
                showNewsAlert()
            }

        } else {
            isNew = true
            showNewsAlert()
        }

        if(isNew){
            ConfigManager.setNewsCache({
                date: newDate.getTime(),
                content: newHash,
                dismissed: false
            })
            ConfigManager.save()
        }

        const switchHandler = (forward) => {
            let cArt = parseInt(newsContent.getAttribute('article'))
            let nxtArt = forward ? (cArt >= newsArr.length-1 ? 0 : cArt + 1) : (cArt <= 0 ? newsArr.length-1 : cArt - 1)
    
            displayArticle(newsArr[nxtArt], nxtArt+1)
        }

        document.getElementById('newsNavigateRight').onclick = () => { switchHandler(true) }
        document.getElementById('newsNavigateLeft').onclick = () => { switchHandler(false) }
        await $('#newsErrorContainer').fadeOut(250).promise()
        displayArticle(newsArr[0], 1)
        await $('#newsContent').fadeIn(250).promise()
    }


}

/**
 * Add keyboard controls to the news UI. Left and right arrows toggle
 * between articles. If you are on the landing page, the up arrow will
 * open the news UI.
 */
document.addEventListener('keydown', (e) => {
    if(newsActive){
        if(e.key === 'ArrowRight' || e.key === 'ArrowLeft'){
            document.getElementById(e.key === 'ArrowRight' ? 'newsNavigateRight' : 'newsNavigateLeft').click()
        }
        // Interferes with scrolling an article using the down arrow.
        // Not sure of a straight forward solution at this point.
        // if(e.key === 'ArrowDown'){
        //     document.getElementById('newsButton').click()
        // }
    } else if(!schematicsActive) {
        if(getCurrentView() === VIEWS.landing){
            if(e.key === 'ArrowUp'){
                document.getElementById('newsButton').click()
            }
        }
    }
})

/**
 * Display a news article on the UI.
 * 
 * @param {Object} articleObject The article meta object.
 * @param {number} index The article index.
 */
function displayArticle(articleObject, index){
    newsArticleTitle.innerHTML = articleObject.title
    newsArticleTitle.href = articleObject.link
    newsArticleAuthor.innerHTML = 'by ' + articleObject.author
    newsArticleDate.innerHTML = articleObject.date
    newsArticleComments.innerHTML = articleObject.comments
    newsArticleComments.href = articleObject.commentsLink
    newsArticleContentScrollable.innerHTML = '<div id="newsArticleContentWrapper"><div class="newsArticleSpacerTop"></div>' + articleObject.content + '<div class="newsArticleSpacerBot"></div></div>'
    Array.from(newsArticleContentScrollable.getElementsByClassName('bbCodeSpoilerButton')).forEach(v => {
        v.onclick = () => {
            const text = v.parentElement.getElementsByClassName('bbCodeSpoilerText')[0]
            text.style.display = text.style.display === 'block' ? 'none' : 'block'
        }
    })
    newsNavigationStatus.innerHTML = Lang.query('ejs.landing.newsNavigationStatus', {currentPage: index, totalPages: newsArr.length})
    newsContent.setAttribute('article', index-1)
}

/**
 * Load news information from the RSS feed specified in the
 * distribution index.
 */
async function loadNews(){

    const distroData = await DistroAPI.getDistribution()
    if(!distroData.rawDistribution.rss) {
        loggerLanding.debug('No RSS feed provided.')
        return null
    }

    const promise = new Promise((resolve, reject) => {
        
        const newsFeed = distroData.rawDistribution.rss
        const newsHost = new URL(newsFeed).origin + '/'
        $.ajax({
            url: newsFeed,
            success: (data) => {
                const items = $(data).find('item')
                const articles = []

                for(let i=0; i<items.length; i++){
                // JQuery Element
                    const el = $(items[i])

                    // Resolve date.
                    const date = new Date(el.find('pubDate').text()).toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric'})

                    // Resolve comments.
                    let comments = el.find('slash\\:comments').text() || '0'
                    comments = comments + ' Comment' + (comments === '1' ? '' : 's')

                    // Fix relative links in content.
                    const content = el.find('content\\:encoded').text().replace(
                        /src="(?!https?:\/\/|\/\/|data:)(.+?)"/g,
                        (_match, assetPath) => {
                            const normalizedPath = String(assetPath || '').replace(/^\/+/, '')
                            return `src="${newsHost}${normalizedPath}"`
                        }
                    )

                    let link   = el.find('link').text()
                    let title  = el.find('title').text()
                    let author = el.find('dc\\:creator').text()

                    // Generate article.
                    articles.push(
                        {
                            link,
                            title,
                            date,
                            author,
                            content,
                            comments,
                            commentsLink: link + '#comments'
                        }
                    )
                }
                resolve({
                    articles
                })
            },
            timeout: 2500
        }).catch(err => {
            resolve({
                articles: null
            })
        })
    })

    return await promise
}

// Signal that all landing-page functions referenced by uibinder.js are ready.
window.heliosLandingReady = true
window.dispatchEvent(new Event('helios:landing-ready'))
