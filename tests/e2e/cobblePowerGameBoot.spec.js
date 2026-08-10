const { test, expect } = require('@playwright/test')
const { _electron: electron } = require('playwright')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const BOOT_TIMEOUT_MS = 180000
const POLL_INTERVAL_MS = 500

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds))
}

test('Cobble Power reaches main-menu resource initialization', async () => {
    test.setTimeout(240000)
    test.skip(
        process.env.E2E_GAME_BOOT !== '1' || !process.env.E2E_PACK_DATA_DIR,
        'Set E2E_GAME_BOOT=1 and E2E_PACK_DATA_DIR to run the real Java boot test.'
    )

    const appDir = path.resolve(__dirname, '..', '..')
    const testerMode = Boolean(process.env.HELIOS_TEST_CHANNEL_PATH)
    const distributionPath = path.join(appDir, 'distribution_dev.json')
    const dataDirectory = path.resolve(process.env.E2E_PACK_DATA_DIR)
    const instanceDirectory = path.join(dataDirectory, 'instances', 'Cobble-Power-1.21.1')
    const latestLogPath = path.join(instanceDirectory, 'logs', 'latest.log')
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cehelios-game-boot-e2e-'))
    const resolvedTempRoot = path.resolve(os.tmpdir()) + path.sep
    const resolvedUserData = path.resolve(userDataDir)
    if(!resolvedUserData.startsWith(resolvedTempRoot) || !path.basename(resolvedUserData).startsWith('cehelios-game-boot-e2e-')){
        throw new Error(`Unexpected E2E directory: ${resolvedUserData}`)
    }

    const electronApp = await electron.launch({
        cwd: appDir,
        args: ['.', `--user-data-dir=${userDataDir}`],
        env: {
            ...process.env,
            NODE_ENV: 'development',
            HELIOS_DISTRO_DEV: '1',
            HELIOS_DISTRO_LOCAL_PATH: distributionPath
        }
    })

    let session
    try {
        const page = await electronApp.firstWindow()
        await page.locator('#main').waitFor({ state: 'visible', timeout: 20000 })
        session = await electronApp.context().newCDPSession(page)
        await session.send('Runtime.enable')

        const launchStartedAt = Date.now()
        const launch = await session.send('Runtime.evaluate', {
            expression: `(async () => {
                ConfigManager.setDataDirectory(${JSON.stringify(dataDirectory)})
                ConfigManager.setSelectedServer('Cobble-Power-1.21.1')
                ConfigManager.setLaunchDetached(false)
                DistroAPI.commonDir = ConfigManager.getCommonDirectory()
                DistroAPI.instanceDir = ConfigManager.getInstanceDirectory()
                ConfigManager.save({ immediate: true })
                await dlAsync(false)

                const distro = await DistroAPI.getDistribution()
                const server = distro.getServerById('Cobble-Power-1.21.1')
                const mojangProcessor = new MojangIndexProcessor(
                    ConfigManager.getCommonDirectory(),
                    server.rawServer.minecraftVersion
                )
                const distributionProcessor = new DistributionIndexProcessor(
                    ConfigManager.getCommonDirectory(),
                    distro,
                    server.rawServer.id,
                    AccessGate.getEntitlements()
                )
                const modLoaderData = await distributionProcessor.loadModLoaderVersionJson(server)
                const versionData = await mojangProcessor.getVersionJson()

                ConfigManager.setJavaExecutable(
                    server.rawServer.id,
                    ${JSON.stringify(path.join(dataDirectory, 'runtime', 'x64', 'jdk-21.0.12+8', 'bin', 'javaw.exe'))}
                )
                const builder = new ProcessBuilder(
                    server,
                    versionData,
                    modLoaderData,
                    {
                        displayName: 'LaunchVerification',
                        uuid: '00000000000000000000000000000000',
                        accessToken: 'not-a-real-access-token',
                        type: 'microsoft'
                    },
                    'test'
                )
                const child = builder.build()
                const output = []
                child.stdout.on('data', data => output.push('[stdout] ' + data))
                child.stderr.on('data', data => output.push('[stderr] ' + data))
                globalThis.__cobblePowerBoot = { child, output }
                return { pid: child.pid }
            })()`,
            awaitPromise: true,
            returnByValue: true
        })

        expect(launch.exceptionDetails).toBeUndefined()
        expect(launch.result.value.pid).toBeGreaterThan(0)

        const deadline = Date.now() + BOOT_TIMEOUT_MS
        let latestLog = ''
        while(Date.now() < deadline){
            if(fs.existsSync(latestLogPath)){
                latestLog = fs.readFileSync(latestLogPath, 'utf8')
                const logIsCurrent = fs.statSync(latestLogPath).mtimeMs >= launchStartedAt
                const baseBootCompleted = latestLog.includes('Kotlin For Forge Enabled!')
                    && latestLog.includes('Sound engine started')
                const testerBootCompleted = !testerMode
                    || (latestLog.includes('mod/cobblepower')
                        && latestLog.includes('Prepared 2203 Pokemon textures'))
                if(logIsCurrent && baseBootCompleted && testerBootCompleted){
                    break
                }
            }

            const childState = await session.send('Runtime.evaluate', {
                expression: `(() => {
                    const state = globalThis.__cobblePowerBoot
                    const child = state?.child
                    return child == null ? null : {
                        exitCode: child.exitCode,
                        signalCode: child.signalCode,
                        output: state.output.slice(-80)
                    }
                })()`,
                returnByValue: true
            })
            if(childState.result.value?.exitCode != null || childState.result.value?.signalCode != null){
                throw new Error([
                    'Minecraft exited before boot completed.',
                    ...childState.result.value.output,
                    latestLog.slice(-12000)
                ].join('\n'))
            }
            await delay(POLL_INTERVAL_MS)
        }

        expect(latestLog).toContain('Kotlin For Forge Enabled!')
        expect(latestLog).toContain('Sound engine started')
        expect(latestLog).not.toContain('NoClassDefFoundError: kotlin/')
        if(testerMode){
            expect(latestLog).toContain('mod/cobblepower')
            expect(latestLog).toContain('Prepared 2203 Pokemon textures')
        }
    } finally {
        if(session != null){
            await session.send('Runtime.evaluate', {
                expression: `(() => {
                    const child = globalThis.__cobblePowerBoot?.child
                    if(child != null && child.exitCode == null && child.signalCode == null){
                        child.kill()
                    }
                })()`
            }).catch(() => {})
            await delay(1500)
        }
        await electronApp.close()
        fs.rmSync(resolvedUserData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
})
