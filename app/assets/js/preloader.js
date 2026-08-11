const {ipcRenderer}  = require('electron')
const fs             = require('fs-extra')
const os             = require('os')
const path           = require('path')

const ConfigManager  = require('./configmanager')
const { DistroAPI }  = require('./distromanager')
const LangLoader     = require('./langloader')
const AccessManager  = require('./accessmanager')
const ChannelManager = require('./channelmanager')
const { seedBundledArtifacts } = require('./testerchannel')
const { LoggerUtil } = require('helios-core')
// eslint-disable-next-line no-unused-vars
const { HeliosDistribution } = require('helios-core/common')

const logger = LoggerUtil.getLogger('Preloader')

logger.info('Loading..')

// Page scripts execute while bootstrapPreloader is awaiting configuration and
// remote-channel work. Load translations synchronously before the first await;
// langloader also initializes lazily as a second line of defense.
LangLoader.setupLanguage()

/**
 * 
 * @param {HeliosDistribution} data 
 */
function onDistroLoad(data){
    if(data != null){
        const servers = data.servers
        const selectedId = ConfigManager.getSelectedServer()
        const selectedServer = selectedId ? data.getServerById(selectedId) : null

        const isServerAccessible = (server) => {
            if(server == null){
                return false
            }
            const walkModules = (modules) => {
                for(const mdl of modules || []){
                    const access = mdl?.rawModule?.access
                    if(access && !AccessManager.hasAccess(access)){
                        return false
                    }
                    if(mdl?.subModules?.length){
                        if(!walkModules(mdl.subModules)){
                            return false
                        }
                    }
                }
                return true
            }
            return walkModules(server.modules)
        }

        // Resolve the selected server if missing or inaccessible.
        if(selectedServer == null || !isServerAccessible(selectedServer)){
            logger.info('Determining accessible selected server..')
            let nextServer = null
            if(servers.length > 0){
                let startIndex = 0
                if(selectedServer != null){
                    startIndex = servers.findIndex(s => s.rawServer.id === selectedServer.rawServer.id)
                    if(startIndex < 0){
                        startIndex = 0
                    }
                }
                for(let i = 0; i < servers.length; i++){
                    const idx = (startIndex + 1 + i) % servers.length
                    if(isServerAccessible(servers[idx])){
                        nextServer = servers[idx]
                        break
                    }
                }
            }
            if(nextServer == null){
                const mainServer = data.getMainServer()
                if(mainServer && isServerAccessible(mainServer)){
                    nextServer = mainServer
                }
            }
            if(nextServer == null && servers.length > 0){
                nextServer = servers[0]
            }
            if(nextServer != null){
                ConfigManager.setSelectedServer(nextServer.rawServer.id)
                ConfigManager.save()
            }
        }
    }
    ipcRenderer.send('distributionIndexDone', data != null)
}

async function bootstrapPreloader(){
    // Load ConfigManager
    await ConfigManager.load()

    const seededArtifacts = seedBundledArtifacts(ConfigManager.getDataDirectory())
    if(seededArtifacts.length > 0){
        logger.info(`Installed ${seededArtifacts.length} bundled tester artifact(s).`)
    }

    // Yuck!
    // TODO Fix this
    DistroAPI['commonDir'] = ConfigManager.getCommonDirectory()
    DistroAPI['instanceDir'] = ConfigManager.getInstanceDirectory()

    if(ChannelManager.isRemoteChannel()) {
        try {
            await ChannelManager.bootstrap()
        } catch(err) {
            logger.warn('Tester channel authorization was not restored during startup.', err.message || err)
        }
    }

    // Ensure Distribution is downloaded and cached.
    DistroAPI.getDistribution()
        .then(heliosDistro => {
            logger.info('Loaded distribution index.')
            onDistroLoad(heliosDistro)
        })
        .catch(err => {
            logger.info('Failed to load an older version of the distribution index.')
            logger.info('Application cannot run.')
            logger.error(err)
            onDistroLoad(null)
        })

    // Clean up temp dir in case previous launches ended unexpectedly.
    fs.remove(path.join(os.tmpdir(), ConfigManager.getTempNativeFolder()), (err) => {
        if(err){
            logger.warn('Error while cleaning natives directory', err)
        } else {
            logger.info('Cleaned natives directory.')
        }
    })
}

bootstrapPreloader().catch((err) => {
    logger.error('Failed to bootstrap preloader.', err)
    ipcRenderer.send('distributionIndexDone', false)
})
