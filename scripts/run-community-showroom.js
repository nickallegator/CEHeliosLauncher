'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { _electron: electron } = require('playwright')

const { createShowroomEnvironment } = require('./lib/community-showroom')

function usage() {
    return [
        'Usage: run-community-showroom.cmd [--keep-data] [--data-dir <path>]',
        '',
        '  --keep-data       Keep the disposable showroom directory after exit.',
        '  --data-dir <path> Use an explicit directory and never remove it automatically.',
        '  --verify          Open, verify the catalog, then close automatically.',
        '  --help            Show this help.'
    ].join('\n')
}

function parseArguments(argv) {
    const options = { keepData: false, dataDirectory: null, verify: false, help: false }
    for(let index = 0; index < argv.length; index += 1) {
        const argument = argv[index]
        if(argument === '--keep-data') options.keepData = true
        else if(argument === '--verify') options.verify = true
        else if(argument === '--help' || argument === '-h' || argument === '/?') options.help = true
        else if(argument === '--data-dir') {
            const value = argv[index + 1]
            if(!value || value.startsWith('--')) throw new Error('--data-dir requires a path.')
            options.dataDirectory = path.resolve(value)
            options.keepData = true
            index += 1
        } else throw new Error(`Unknown argument: ${argument}`)
    }
    return options
}

async function waitForApplicationClose(application) {
    await new Promise(resolve => application.once('close', resolve))
}

async function run(argv = process.argv.slice(2)) {
    const options = parseArguments(argv)
    if(options.help) {
        console.log(usage())
        return 0
    }
    const appDirectory = path.resolve(__dirname, '..')
    const electronExecutable = path.join(appDirectory, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
    if(!fs.existsSync(electronExecutable)) {
        throw new Error('Electron dependencies are not installed. Run npm install in the launcher repository first.')
    }
    const runtime = await createShowroomEnvironment({
        appDirectory,
        ...(options.dataDirectory ? { rootDirectory: options.dataDirectory } : {})
    })
    let application = null
    let shuttingDown = false
    const cleanup = async () => {
        if(shuttingDown) return
        shuttingDown = true
        if(application) await application.close().catch(() => {})
        await runtime.api.close().catch(() => {})
        if(!options.keepData) fs.rmSync(runtime.rootDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
    const handleSignal = () => {
        cleanup().then(() => { process.exitCode = 130 }).catch(error => {
            console.error(error.stack || error.message || error)
            process.exitCode = 1
        })
    }
    process.once('SIGINT', handleSignal)
    process.once('SIGTERM', handleSignal)
    try {
        console.log('AG Launcher Local Community Showroom')
        console.log(`  API:      ${runtime.apiBaseUrl}`)
        console.log(`  Data:     ${runtime.rootDirectory}`)
        console.log(`  Instance: ${runtime.instanceRoot}`)
        console.log(`  Cleanup:  ${options.keepData ? 'preserved after exit' : 'automatic after exit'}`)
        console.log('  Safety:   publishing and game launch are disabled')
        console.log('')
        console.log('Close the launcher window when you are finished.')
        application = await electron.launch({
            cwd: appDirectory,
            args: ['.', `--user-data-dir=${runtime.launcherDirectory}`],
            env: runtime.environment
        })
        const page = await application.firstWindow()
        await page.waitForLoadState('domcontentloaded')
        await page.locator('#loadingContainer').waitFor({ state: 'hidden', timeout: 20_000 })
        await page.locator('#shellNavCommunity').click()
        await page.locator('.schematicCard').first().waitFor({ state: 'visible', timeout: 10_000 })
        console.log(`Showroom ready with ${runtime.entries.length} representative creations.`)
        if(options.verify) {
            await application.close()
            application = null
            console.log('Showroom verification completed successfully.')
            return 0
        }
        await waitForApplicationClose(application)
        application = null
        return 0
    } finally {
        process.removeListener('SIGINT', handleSignal)
        process.removeListener('SIGTERM', handleSignal)
        await cleanup()
        if(options.keepData) console.log(`Showroom data preserved at: ${runtime.rootDirectory}`)
    }
}

if(require.main === module) {
    run().then(code => { process.exitCode = code }).catch(error => {
        console.error(`Unable to start the Community showroom: ${error.stack || error.message || error}`)
        process.exitCode = 1
    })
}

module.exports = { parseArguments, run, usage, waitForApplicationClose }
