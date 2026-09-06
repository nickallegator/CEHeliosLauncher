const remoteMain = require('@electron/remote/main')
remoteMain.initialize()

// Requirements
const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron')
const autoUpdater                       = require('electron-updater').autoUpdater
const ejse                              = require('ejs-electron')
const http                              = require('http')
const isDev                             = require('./app/assets/js/isdev')
const path                              = require('path')
const { pathToFileURL }                 = require('url')
const { AZURE_CLIENT_ID, MSFT_OPCODE, MSFT_REPLY_TYPE, MSFT_ERROR, SHELL_OPCODE } = require('./app/assets/js/ipcconstants')
const LangLoader                        = require('./app/assets/js/langloader')
const { MICROSOFT_AUTH_REDIRECT_URI, parseMicrosoftAuthRedirect } = require('./app/assets/js/microsoftauthredirect')
const { loadTesterChannel }             = require('./app/assets/js/testerchannel')
const { getLauncherChannel }            = require('./app/assets/js/launcheridentity')
const Brand                             = require('./app/assets/js/brand')
const { migrateBrandUserData }          = require('./app/assets/js/brandmigration')
const { LauncherUpdateManager }         = require('./app/assets/js/launcherupdater')

// Keep a global reference of the primary window object. Authentication
// windows must never be able to invoke privileged launcher update actions.
let win

app.setName(Brand.productName)
app.setAppUserModelId(Brand.appId)

try {
    const appDataDirectory = path.resolve(app.getPath('appData'))
    const targetDirectory = path.resolve(app.getPath('userData'))
    const defaultTargetDirectory = path.join(appDataDirectory, Brand.userDataDirectoryName)
    if(targetDirectory.toLowerCase() === defaultTargetDirectory.toLowerCase()) {
        const migration = migrateBrandUserData({
            appDataDirectory,
            targetDirectory,
            legacyNames: Brand.legacyUserDataDirectoryNames
        })
        if(migration.migrated) {
            console.log(`[Brand] Migrated durable launcher state from ${migration.sourceDirectory}`)
        }
    }
} catch(error) {
    // A migration failure must not prevent first launch. The old state remains
    // untouched and can be copied after the underlying filesystem issue clears.
    console.error('[Brand] Unable to migrate previous launcher state.', error)
}

// Setup Lang
LangLoader.setupLanguage()

let packagedChannel = null
try {
    packagedChannel = loadTesterChannel()
} catch(error) {
    console.error('[Updater] Unable to load packaged channel metadata.', error.message)
}

const updaterEnabled = app.isPackaged
    && !isDev
    && process.platform === 'win32'
    && process.env.AG_COMMUNITY_SHOWROOM !== '1'
    && (packagedChannel == null || packagedChannel.schemaVersion === 2)
const updateChannel = getLauncherChannel(app.getVersion())
const launcherUpdateManager = new LauncherUpdateManager({
    updater: autoUpdater,
    currentVersion: app.getVersion(),
    channel: updateChannel,
    enabled: updaterEnabled,
    broadcast(state) {
        if(win && !win.isDestroyed()) win.webContents.send('launcher-update:state-changed', state)
    }
})

function requirePrimaryRenderer(event) {
    if(!win || win.isDestroyed() || event.sender.id !== win.webContents.id) {
        throw Object.assign(new Error('Launcher update actions are restricted to the primary window.'), { code: 'forbidden_sender' })
    }
}

ipcMain.handle('launcher-update:get-state', event => {
    requirePrimaryRenderer(event)
    return launcherUpdateManager.snapshot()
})
ipcMain.handle('launcher-update:initialize', async (event, options = {}) => {
    requirePrimaryRenderer(event)
    launcherUpdateManager.initialize()
    await launcherUpdateManager.check({ allowPrerelease: options?.allowPrerelease === true })
    return launcherUpdateManager.snapshot()
})
ipcMain.handle('launcher-update:check', async (event, options = {}) => {
    requirePrimaryRenderer(event)
    return launcherUpdateManager.check({ allowPrerelease: options?.allowPrerelease === true })
})
ipcMain.handle('launcher-update:download', async event => {
    requirePrimaryRenderer(event)
    return launcherUpdateManager.download()
})
ipcMain.handle('launcher-update:defer', event => {
    requirePrimaryRenderer(event)
    return launcherUpdateManager.defer()
})
ipcMain.handle('launcher-update:set-game-running', (event, running) => {
    requirePrimaryRenderer(event)
    return launcherUpdateManager.setGameRunning(running)
})
ipcMain.handle('launcher-update:install', event => {
    requirePrimaryRenderer(event)
    return launcherUpdateManager.install()
})
// Cache distribution results by renderer so a fast local preload cannot race
// the page listener. The renderer explicitly announces when its listener is
// ready and receives the latest result if the preload already completed.
const distributionIndexResults = new Map()
const distributionIndexCleanupAttached = new Set()

function trackDistributionRenderer(sender) {
    if(distributionIndexCleanupAttached.has(sender.id)){
        return
    }
    distributionIndexCleanupAttached.add(sender.id)
    sender.once('destroyed', () => {
        distributionIndexResults.delete(sender.id)
        distributionIndexCleanupAttached.delete(sender.id)
    })
}

ipcMain.on('distributionIndexDone', (event, res) => {
    trackDistributionRenderer(event.sender)
    distributionIndexResults.set(event.sender.id, res)
    if(process.env.HELIOS_DISTRO_DEV === '1'){
        console.log('[Main] distributionIndexDone', res)
    }
    event.sender.send('distributionIndexDone', res)
})

ipcMain.on('distributionIndexReady', (event) => {
    trackDistributionRenderer(event.sender)
    if(distributionIndexResults.has(event.sender.id)){
        event.sender.send('distributionIndexDone', distributionIndexResults.get(event.sender.id))
    }
})

ipcMain.on('rendererError', (_event, payload) => {
    console.error('[Renderer]', payload?.kind || 'error', payload?.message || payload)
    if(payload?.stack) {
        console.error(payload.stack)
    }
})

let patreonAuthServer = null
let patreonAuthPort = null
ipcMain.handle('patreon:startAuthServer', async () => {
    if(patreonAuthServer != null) {
        try {
            patreonAuthServer.close()
        } catch (_err) {
            // ignore
        }
        patreonAuthServer = null
        patreonAuthPort = null
    }

    return new Promise((resolve, reject) => {
        patreonAuthServer = http.createServer((req, res) => {
            const url = new URL(req.url, 'http://127.0.0.1')
            const token = url.searchParams.get('token')
            if(token) {
                console.log('[Patreon] received token')
                if(win && !win.isDestroyed()) {
                    win.webContents.send('patreon:token', token)
                }
                res.writeHead(200, { 'Content-Type': 'text/html' })
                res.end('<html><body><h1>Patreon linked.</h1>You can close this window.</body></html>')
                patreonAuthServer.close()
                patreonAuthServer = null
                patreonAuthPort = null
                return
            }
            res.writeHead(400, { 'Content-Type': 'text/plain' })
            res.end('Missing token.')
        })

        patreonAuthServer.on('error', (err) => {
            console.error('[Patreon] auth server error', err)
            reject(err)
        })

        patreonAuthServer.listen(0, '127.0.0.1', () => {
            const address = patreonAuthServer.address()
            patreonAuthPort = address.port
            console.log('[Patreon] auth server listening', `127.0.0.1:${patreonAuthPort}`)
            resolve(`http://127.0.0.1:${patreonAuthPort}/patreon/callback?token={token}`)
        })
    })
})

// Handle trash item.
ipcMain.handle(SHELL_OPCODE.TRASH_ITEM, async (event, ...args) => {
    try {
        await shell.trashItem(args[0])
        return {
            result: true
        }
    } catch(error) {
        return {
            result: false,
            error: error
        }
    }
})

if(process.env.HELIOS_DISABLE_HARDWARE_ACCELERATION === '1'){
    app.disableHardwareAcceleration()
}


// Microsoft Auth Login
let msftAuthWindow
let msftAuthSuccess
let msftAuthViewSuccess
let msftAuthViewOnClose
ipcMain.on(MSFT_OPCODE.OPEN_LOGIN, (ipcEvent, ...arguments_) => {
    if (msftAuthWindow) {
        ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.ALREADY_OPEN, msftAuthViewOnClose)
        return
    }
    msftAuthSuccess = false
    msftAuthViewSuccess = arguments_[0]
    msftAuthViewOnClose = arguments_[1]
    msftAuthWindow = new BrowserWindow({
        title: LangLoader.queryJS('index.microsoftLoginTitle'),
        backgroundColor: '#222222',
        width: 520,
        height: 600,
        frame: true,
        icon: getPlatformIcon()
    })

    msftAuthWindow.on('closed', () => {
        msftAuthWindow = undefined
    })

    msftAuthWindow.on('close', () => {
        if(!msftAuthSuccess) {
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.NOT_FINISHED, msftAuthViewOnClose)
        }
    })

    msftAuthWindow.webContents.on('did-navigate', (_, uri) => {
        const queryMap = parseMicrosoftAuthRedirect(uri)
        if (queryMap != null) {

            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.SUCCESS, queryMap, msftAuthViewSuccess)

            msftAuthSuccess = true
            msftAuthWindow.close()
            msftAuthWindow = null
        }
    })

    msftAuthWindow.removeMenu()
    msftAuthWindow.loadURL(`https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?prompt=select_account&client_id=${AZURE_CLIENT_ID}&response_type=code&scope=XboxLive.signin%20offline_access&redirect_uri=${encodeURIComponent(MICROSOFT_AUTH_REDIRECT_URI)}`)
})

// Microsoft Auth Logout
let msftLogoutWindow
let msftLogoutSuccess
let msftLogoutSuccessSent
ipcMain.on(MSFT_OPCODE.OPEN_LOGOUT, (ipcEvent, uuid, isLastAccount) => {
    if (msftLogoutWindow) {
        ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.ALREADY_OPEN)
        return
    }

    msftLogoutSuccess = false
    msftLogoutSuccessSent = false
    msftLogoutWindow = new BrowserWindow({
        title: LangLoader.queryJS('index.microsoftLogoutTitle'),
        backgroundColor: '#222222',
        width: 520,
        height: 600,
        frame: true,
        icon: getPlatformIcon()
    })

    msftLogoutWindow.on('closed', () => {
        msftLogoutWindow = undefined
    })

    msftLogoutWindow.on('close', () => {
        if(!msftLogoutSuccess) {
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.NOT_FINISHED)
        } else if(!msftLogoutSuccessSent) {
            msftLogoutSuccessSent = true
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.SUCCESS, uuid, isLastAccount)
        }
    })
    
    msftLogoutWindow.webContents.on('did-navigate', (_, uri) => {
        if(uri.startsWith('https://login.microsoftonline.com/common/oauth2/v2.0/logoutsession')) {
            msftLogoutSuccess = true
            setTimeout(() => {
                if(!msftLogoutSuccessSent) {
                    msftLogoutSuccessSent = true
                    ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.SUCCESS, uuid, isLastAccount)
                }

                if(msftLogoutWindow) {
                    msftLogoutWindow.close()
                    msftLogoutWindow = null
                }
            }, 5000)
        }
    })
    
    msftLogoutWindow.removeMenu()
    msftLogoutWindow.loadURL('https://login.microsoftonline.com/common/oauth2/v2.0/logout')
})

function createWindow() {

    win = new BrowserWindow({
        width: 1180,
        height: 680,
        minWidth: 980,
        minHeight: 600,
        icon: getPlatformIcon(),
        frame: false,
        webPreferences: {
            preload: path.join(__dirname, 'app', 'assets', 'js', 'preloader.js'),
            nodeIntegration: true,
            contextIsolation: false
        },
        backgroundColor: '#171614'
    })
    remoteMain.enable(win.webContents)

    const data = {
        lang: (str, placeHolders) => LangLoader.queryEJS(str, placeHolders)
    }
    Object.entries(data).forEach(([key, val]) => ejse.data(key, val))

    win.loadURL(pathToFileURL(path.join(__dirname, 'app', 'app.ejs')).toString())

    /*win.once('ready-to-show', () => {
        win.show()
    })*/

    win.removeMenu()

    win.resizable = true

    win.on('closed', () => {
        win = null
    })
}

function createMenu() {
    
    if(process.platform === 'darwin') {

        // Extend default included application menu to continue support for quit keyboard shortcut
        let applicationSubMenu = {
            label: 'Application',
            submenu: [{
                label: 'About Application',
                selector: 'orderFrontStandardAboutPanel:'
            }, {
                type: 'separator'
            }, {
                label: 'Quit',
                accelerator: 'Command+Q',
                click: () => {
                    app.quit()
                }
            }]
        }

        // New edit menu adds support for text-editing keyboard shortcuts
        let editSubMenu = {
            label: 'Edit',
            submenu: [{
                label: 'Undo',
                accelerator: 'CmdOrCtrl+Z',
                selector: 'undo:'
            }, {
                label: 'Redo',
                accelerator: 'Shift+CmdOrCtrl+Z',
                selector: 'redo:'
            }, {
                type: 'separator'
            }, {
                label: 'Cut',
                accelerator: 'CmdOrCtrl+X',
                selector: 'cut:'
            }, {
                label: 'Copy',
                accelerator: 'CmdOrCtrl+C',
                selector: 'copy:'
            }, {
                label: 'Paste',
                accelerator: 'CmdOrCtrl+V',
                selector: 'paste:'
            }, {
                label: 'Select All',
                accelerator: 'CmdOrCtrl+A',
                selector: 'selectAll:'
            }]
        }

        // Bundle submenus into a single template and build a menu object with it
        let menuTemplate = [applicationSubMenu, editSubMenu]
        let menuObject = Menu.buildFromTemplate(menuTemplate)

        // Assign it to the application
        Menu.setApplicationMenu(menuObject)

    }

}

function getPlatformIcon(){
    return path.join(__dirname, 'app', 'assets', 'brand', 'allegator-games-app-icon.png')
}

app.on('ready', createWindow)
app.on('ready', createMenu)

app.on('window-all-closed', () => {
    // On macOS it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

app.on('before-quit', () => launcherUpdateManager.dispose())

app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (win === null) {
        createWindow()
    }
})
