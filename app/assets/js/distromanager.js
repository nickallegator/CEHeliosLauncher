const { DistributionAPI, HeliosDistribution } = require('helios-core/common')
const path = require('path')
const fs = require('fs')

const ConfigManager = require('./configmanager')
const { loadTesterChannel } = require('./testerchannel')
const { writeJsonAtomic } = require('./atomicjson')

// Old WesterosCraft url.
// exports.REMOTE_DISTRO_URL = 'http://mc.westeroscraft.com/WesterosCraftLauncher/distribution.json'
exports.REMOTE_DISTRO_URL = 'https://helios-files.geekcorner.eu.org/distribution.json'

const testerChannel = loadTesterChannel()
const useDevDistro = process.env.HELIOS_DISTRO_DEV === '1' || testerChannel != null

const api = new DistributionAPI(
    ConfigManager.getLauncherDirectory(),
    null, // Injected forcefully by the preloader.
    null, // Injected forcefully by the preloader.
    exports.REMOTE_DISTRO_URL,
    useDevDistro
)

if(useDevDistro) {
    const canonicalTesterPath = path.resolve(ConfigManager.getLauncherDirectory(), 'distribution_dev.json')
    const localDevPath = testerChannel != null
        ? testerChannel.schemaVersion === 2
            ? canonicalTesterPath
            : testerChannel.distributionPath
        : process.env.HELIOS_DISTRO_LOCAL_PATH
            ? path.resolve(process.env.HELIOS_DISTRO_LOCAL_PATH)
            : path.resolve(__dirname, '..', '..', '..', 'distribution_dev.json')
    if(testerChannel?.schemaVersion === 2) {
        let validCachedDistribution = false
        try {
            const cached = JSON.parse(fs.readFileSync(localDevPath, 'utf8'))
            validCachedDistribution = cached != null && typeof cached === 'object' && Array.isArray(cached.servers)
        } catch(_err) {
            validCachedDistribution = false
        }
        if(!validCachedDistribution) {
            fs.mkdirSync(path.dirname(localDevPath), { recursive: true })
            fs.copyFileSync(testerChannel.bootstrapDistributionPath, localDevPath)
        }
    }
    if(fs.existsSync(localDevPath)) {
        api.distroDevPath = localDevPath
        if(testerChannel != null) {
            console.log(`[Distro] Using bundled tester channel ${testerChannel.id}:`, localDevPath)
        } else if(process.env.HELIOS_DISTRO_DEV === '1') {
            console.log('[Distro] Using local dev distribution:', localDevPath)
        }

        const repairSnapshotPath = canonicalTesterPath

        const stageRepairSnapshot = (distribution) => {
            const serialized = JSON.stringify(distribution, null, 4)
            if(fs.existsSync(repairSnapshotPath) && fs.readFileSync(repairSnapshotPath, 'utf8') === serialized){
                return
            }

            fs.mkdirSync(path.dirname(repairSnapshotPath), { recursive: true })
            const temporaryPath = `${repairSnapshotPath}.${process.pid}.tmp`
            try {
                fs.writeFileSync(temporaryPath, serialized, 'utf8')
                fs.renameSync(temporaryPath, repairSnapshotPath)
            } finally {
                if(fs.existsSync(temporaryPath)){
                    fs.rmSync(temporaryPath, { force: true })
                }
            }
        }

        const wrapAndStage = (methodName) => {
            const original = api[methodName].bind(api)
            api[methodName] = async (...args) => {
                const distribution = await original(...args)
                stageRepairSnapshot(distribution.rawDistribution)
                return distribution
            }
        }

        // The repair receiver runs in a child process and constructs its own
        // DistributionAPI, which reads from the canonical user-data path.
        // Keep an atomic snapshot there while the renderer continues to use
        // the repository source for development refreshes.
        wrapAndStage('getDistribution')
        wrapAndStage('refreshDistributionOrFallback')
    }
}

function validateTesterDistribution(rawDistribution) {
    if(testerChannel?.schemaVersion !== 2) {
        throw new Error('Authorized distributions are only supported by tester-channel schema v2')
    }
    if(rawDistribution == null || typeof rawDistribution !== 'object' || Array.isArray(rawDistribution)) {
        throw new Error('Authorized distribution must be a JSON object')
    }
    const bootstrap = JSON.parse(fs.readFileSync(testerChannel.bootstrapDistributionPath, 'utf8'))
    const expectedServerId = bootstrap?.servers?.[0]?.id
    if(!expectedServerId || !Array.isArray(rawDistribution.servers)
        || !rawDistribution.servers.some(server => server?.id === expectedServerId)) {
        throw new Error(`Authorized distribution must preserve tester profile ${expectedServerId || '<missing>'}`)
    }
    return new HeliosDistribution(rawDistribution, api.commonDir, api.instanceDir)
}

function installTesterDistribution(rawDistribution) {
    const parsed = validateTesterDistribution(rawDistribution)
    writeJsonAtomic(api.distroDevPath, rawDistribution)
    api.rawDistribution = rawDistribution
    api.distribution = parsed
    return parsed
}

function resetTesterDistributionToBootstrap() {
    if(testerChannel?.schemaVersion !== 2) return null
    const bootstrap = JSON.parse(fs.readFileSync(testerChannel.bootstrapDistributionPath, 'utf8'))
    const parsed = new HeliosDistribution(bootstrap, api.commonDir, api.instanceDir)
    writeJsonAtomic(api.distroDevPath, bootstrap)
    api.rawDistribution = bootstrap
    api.distribution = parsed
    return parsed
}

exports.DistroAPI = api
exports.TesterChannel = testerChannel
exports.installTesterDistribution = installTesterDistribution
exports.resetTesterDistributionToBootstrap = resetTesterDistributionToBootstrap
exports.validateTesterDistribution = validateTesterDistribution
