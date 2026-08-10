const { test, expect } = require('@playwright/test')
const { _electron: electron } = require('playwright')
const AdmZip = require('adm-zip')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

test('Cobble Power repair installs the locked default mod set', async () => {
    test.setTimeout(600000)
    test.skip(
        process.env.E2E_PACK_REPAIR !== '1' || !process.env.E2E_PACK_DATA_DIR,
        'Set E2E_PACK_REPAIR=1 and E2E_PACK_DATA_DIR to run the download/repair acceptance test.'
    )

    const appDir = path.resolve(__dirname, '..', '..')
    const testerMode = Boolean(process.env.HELIOS_TEST_CHANNEL_PATH)
    const distributionPath = path.join(appDir, 'distribution_dev.json')
    const dataDirectory = path.resolve(process.env.E2E_PACK_DATA_DIR)
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cehelios-repair-e2e-'))
    const resolvedTempRoot = path.resolve(os.tmpdir()) + path.sep
    const resolvedUserData = path.resolve(userDataDir)
    if(!resolvedUserData.startsWith(resolvedTempRoot) || !path.basename(resolvedUserData).startsWith('cehelios-repair-e2e-')){
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

    try {
        const processLog = []
        electronApp.process().stdout?.on('data', data => processLog.push(`[stdout] ${data}`))
        electronApp.process().stderr?.on('data', data => processLog.push(`[stderr] ${data}`))
        const page = await electronApp.firstWindow()
        const rendererErrors = []
        const rendererLog = []
        page.on('pageerror', err => rendererErrors.push(err.message))
        page.on('console', message => rendererLog.push(`[${message.type()}] ${message.text()}`))
        try {
            await page.locator('#main').waitFor({ state: 'visible', timeout: 20000 })
        } catch(err) {
            throw new Error([
                err.message,
                ...processLog.slice(-80),
                ...rendererLog.slice(-80)
            ].join('\n'))
        }

        const session = await electronApp.context().newCDPSession(page)
        await session.send('Runtime.enable')
        const evaluation = await session.send('Runtime.evaluate', {
            expression: `(async () => {
                ConfigManager.setDataDirectory(${JSON.stringify(dataDirectory)})
                ConfigManager.setSelectedServer('Cobble-Power-1.21.1')
                DistroAPI.commonDir = ConfigManager.getCommonDirectory()
                DistroAPI.instanceDir = ConfigManager.getInstanceDirectory()
                ConfigManager.save({ immediate: true })
                await dlAsync(false)
                return {
                    overlayVisible: isOverlayVisible(),
                    overlayTitle: document.getElementById('overlayTitle').textContent,
                    overlayDescription: document.getElementById('overlayDesc').textContent,
                    launchDetails: document.getElementById('launch_details_text').textContent
                }
            })()`,
            awaitPromise: true,
            returnByValue: true
        })

        expect(evaluation.exceptionDetails).toBeUndefined()
        if(evaluation.result.value.overlayVisible){
            throw new Error([
                evaluation.result.value.overlayTitle,
                evaluation.result.value.overlayDescription,
                ...processLog.slice(-80),
                ...rendererLog.slice(-40)
            ].join('\n'))
        }
        expect(rendererErrors).toEqual([])

        const modStoreDirectory = path.join(dataDirectory, 'common', 'modstore')
        const installedMods = fs.readdirSync(modStoreDirectory, { recursive: true, withFileTypes: true })
            .filter(entry => entry.isFile() && entry.name.endsWith('.jar'))
            .map(entry => entry.name)
            .sort()
        const expectedInstalledMods = [
            'curios-neoforge-9.5.1+1.21.1.jar',
            'farmers-delight-398521-6917256.jar',
            'geckolib-neoforge-1.21.1-4.7.3.jar',
            'jade-324717-6011258.jar',
            'jei-1.21.1-neoforge-19.27.0.336.jar',
            'kffmod-neoforge-5.3.0.jar',
            'neoforge-1.6.0+1.21.1-HEAD-f77af7c.jar'
        ]
        if(testerMode){
            expectedInstalledMods.push('cobblepower-1.0.0.jar')
        }
        expect(installedMods).toEqual(expect.arrayContaining(expectedInstalledMods))

        const kotlinForForgeLibraryDirectory = path.join(
            dataDirectory,
            'common',
            'libraries',
            'thedarkcolour'
        )
        const kotlinLanguagePath = path.join(
            kotlinForForgeLibraryDirectory,
            'kfflang-neoforge',
            '5.3.0',
            'kfflang-neoforge-5.3.0.jar'
        )
        const kotlinApiPath = path.join(
            kotlinForForgeLibraryDirectory,
            'kfflib-neoforge',
            '5.3.0',
            'kfflib-neoforge-5.3.0.jar'
        )
        const kotlinStdlibPath = path.join(
            dataDirectory,
            'common',
            'libraries',
            'org',
            'jetbrains',
            'kotlin',
            'kotlin-stdlib',
            '2.0.0',
            'kotlin-stdlib-2.0.0.jar'
        )
        const kotlinCoroutinesPath = path.join(
            dataDirectory,
            'common',
            'libraries',
            'org',
            'jetbrains',
            'kotlinx',
            'kotlinx-coroutines-core-jvm',
            '1.8.1',
            'kotlinx-coroutines-core-jvm-1.8.1.jar'
        )
        const kotlinSerializationPath = path.join(
            dataDirectory,
            'common',
            'libraries',
            'org',
            'jetbrains',
            'kotlinx',
            'kotlinx-serialization-json-jvm',
            '1.7.0',
            'kotlinx-serialization-json-jvm-1.7.0.jar'
        )
        expect(fs.existsSync(kotlinLanguagePath)).toBe(true)
        expect(fs.existsSync(kotlinApiPath)).toBe(true)
        expect(fs.existsSync(kotlinStdlibPath)).toBe(true)
        expect(fs.existsSync(kotlinCoroutinesPath)).toBe(true)
        expect(fs.existsSync(kotlinSerializationPath)).toBe(true)

        expect(new AdmZip(kotlinStdlibPath).getEntry(
            'kotlin/jvm/internal/Intrinsics.class'
        )).not.toBeNull()
        expect(new AdmZip(kotlinCoroutinesPath).getEntry(
            'kotlinx/coroutines/CoroutineScope.class'
        )).not.toBeNull()
        expect(new AdmZip(kotlinSerializationPath).getEntry(
            'kotlinx/serialization/json/Json.class'
        )).not.toBeNull()

        const languageProviderService = new AdmZip(kotlinLanguagePath).readAsText(
            'META-INF/services/net.neoforged.neoforgespi.language.IModLanguageLoader'
        )
        expect(languageProviderService).toContain(
            'thedarkcolour.kotlinforforge.neoforge.KotlinLanguageLoader'
        )

        const neoForgeClient = path.join(
            dataDirectory,
            'common',
            'libraries',
            'net',
            'neoforged',
            'neoforge',
            '21.1.77',
            'neoforge-21.1.77-client.jar'
        )
        expect(fs.existsSync(neoForgeClient)).toBe(true)

        const launchBuild = await session.send('Runtime.evaluate', {
            expression: `(async () => {
                const childProcess = require('child_process')
                const { EventEmitter } = require('events')
                const { PassThrough } = require('stream')
                const originalSpawn = childProcess.spawn
                let capturedSpawn = null

                childProcess.spawn = (executable, args, options) => {
                    capturedSpawn = { executable, args, options }
                    const child = new EventEmitter()
                    child.stdout = new PassThrough()
                    child.stderr = new PassThrough()
                    child.unref = () => {}
                    return child
                }

                try {
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
                    builder.build()

                    const modListPath = capturedSpawn.args[
                        capturedSpawn.args.indexOf('--fml.modLists') + 1
                    ]
                    const modRefs = require('fs').readFileSync(modListPath, 'utf8')
                        .split(/\\r?\\n/)
                        .filter(Boolean)

                    return {
                        executable: capturedSpawn.executable,
                        mainClass: modLoaderData.mainClass,
                        args: capturedSpawn.args,
                        classpath: capturedSpawn.args[capturedSpawn.args.indexOf('-cp') + 1],
                        modRefs,
                        workingDirectory: capturedSpawn.options.cwd
                    }
                } finally {
                    childProcess.spawn = originalSpawn
                }
            })()`,
            awaitPromise: true,
            returnByValue: true
        })

        expect(launchBuild.exceptionDetails).toBeUndefined()
        expect(launchBuild.result.value.executable).toContain('jdk-21.0.12+8')
        expect(launchBuild.result.value.mainClass).toBeTruthy()
        expect(launchBuild.result.value.args).toContain('--fml.mavenRoots')
        expect(launchBuild.result.value.args).toContain('--fml.modLists')
        expect(launchBuild.result.value.args).not.toContain('--quickPlayMultiplayer')
        expect(launchBuild.result.value.classpath).not.toContain('kotlinforforge-neoforge-5.3.0-all.jar')
        expect(launchBuild.result.value.classpath).toContain('kfflang-neoforge-5.3.0.jar')
        expect(launchBuild.result.value.classpath).toContain('kfflib-neoforge-5.3.0.jar')
        expect(launchBuild.result.value.classpath).toContain('annotations-13.0.jar')
        expect(launchBuild.result.value.classpath).toContain('kotlin-stdlib-2.0.0.jar')
        expect(launchBuild.result.value.classpath).toContain('kotlin-stdlib-jdk7-2.0.0.jar')
        expect(launchBuild.result.value.classpath).toContain('kotlin-stdlib-jdk8-2.0.0.jar')
        expect(launchBuild.result.value.classpath).toContain('kotlin-reflect-2.0.0.jar')
        expect(launchBuild.result.value.classpath).toContain('kotlinx-coroutines-core-jvm-1.8.1.jar')
        expect(launchBuild.result.value.classpath).toContain('kotlinx-coroutines-jdk8-1.8.1.jar')
        expect(launchBuild.result.value.classpath).toContain('kotlinx-serialization-core-jvm-1.7.0.jar')
        expect(launchBuild.result.value.classpath).toContain('kotlinx-serialization-json-jvm-1.7.0.jar')
        expect(launchBuild.result.value.modRefs).toHaveLength(testerMode ? 8 : 7)
        const expectedModRefs = [
            'com.cobblemon:neoforge:1.6.0+1.21.1-HEAD-f77af7c',
            'thedarkcolour:kffmod-neoforge:5.3.0',
            'mezz.jei:jei-1.21.1-neoforge:19.27.0.336',
            'top.theillusivec4.curios:curios-neoforge:9.5.1+1.21.1'
        ]
        if(testerMode){
            expectedModRefs.push('net.allegator.cobblepower:cobblepower:1.0.0')
        }
        expect(launchBuild.result.value.modRefs).toEqual(expect.arrayContaining(expectedModRefs))
        expect(launchBuild.result.value.modRefs).not.toContain(
            'thedarkcolour:kotlinforforge-neoforge:5.3.0:all'
        )
        expect(path.resolve(launchBuild.result.value.workingDirectory)).toBe(
            path.join(dataDirectory, 'instances', 'Cobble-Power-1.21.1')
        )
    } finally {
        await electronApp.close()
        fs.rmSync(resolvedUserData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
})
