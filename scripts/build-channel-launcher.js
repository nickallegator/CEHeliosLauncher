'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const { writeJsonAtomic } = require('./lib/pack-generator')

const root = path.resolve(__dirname, '..')
const configPath = path.join(root, 'packs', 'cobble-power-channel-launcher.json')
const stagingRoot = path.join(root, 'dist', 'channel-staging')
const outputRoot = path.join(root, 'dist', 'channel-output')

function parseArgs(argv) {
    const result = {}
    for(let index = 2; index < argv.length; index++) {
        const key = argv[index]
        if(!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`)
        const next = argv[index + 1]
        if(next == null || next.startsWith('--')) result[key.slice(2)] = true
        else {
            result[key.slice(2)] = next
            index++
        }
    }
    return result
}

function validateApiBase(value) {
    let parsed
    try { parsed = new URL(value) } catch(_err) { throw new Error('--api-url must be a valid HTTPS URL') }
    if(parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
        throw new Error('--api-url must use HTTPS')
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, '')
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/+$/, '')
}

function prepare(apiBase, options = {}) {
    const build = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const channel = {
        ...build.channel,
        remoteDistributionUrl: `${apiBase}/v1/releases/channels/${encodeURIComponent(build.channel.channel)}/distribution`
    }
    const targetStagingRoot = options.stagingRoot ? path.resolve(options.stagingRoot) : stagingRoot
    const targetTesterRoot = path.join(targetStagingRoot, 'tester')
    fs.rmSync(targetStagingRoot, { recursive: true, force: true })
    fs.mkdirSync(targetTesterRoot, { recursive: true })
    fs.copyFileSync(path.join(root, 'packs', 'distribution_bootstrap.json'), path.join(targetTesterRoot, 'distribution_bootstrap.json'))
    writeJsonAtomic(path.join(targetTesterRoot, 'tester-channel.json'), channel)
    return build
}

function verifyOutput(apiBase, build, options = {}) {
    const targetOutputRoot = options.outputRoot ? path.resolve(options.outputRoot) : outputRoot
    const testerRoot = path.join(targetOutputRoot, 'win-unpacked', 'resources', 'tester')
    const channelPath = path.join(testerRoot, 'tester-channel.json')
    const bootstrapPath = path.join(testerRoot, build.channel.bootstrapDistribution)
    const installerPath = path.join(
        targetOutputRoot,
        `Cobble-Power-Test-Channel-setup-${build.launcherVersion}.exe`
    )

    for(const requiredPath of [channelPath, bootstrapPath, installerPath]) {
        if(!fs.existsSync(requiredPath)) {
            throw new Error(`Channel build is incomplete: ${requiredPath} is missing`)
        }
    }

    const channel = JSON.parse(fs.readFileSync(channelPath, 'utf8'))
    const expectedDistributionUrl = `${apiBase}/v1/releases/channels/${encodeURIComponent(build.channel.channel)}/distribution`
    if(channel.schemaVersion !== 2 || channel.id !== build.channel.id) {
        throw new Error('Packaged tester-channel.json does not match the configured schema or channel ID')
    }
    if(channel.remoteDistributionUrl !== expectedDistributionUrl) {
        throw new Error(`Packaged channel URL is invalid: expected ${expectedDistributionUrl}`)
    }

    const bootstrap = JSON.parse(fs.readFileSync(bootstrapPath, 'utf8'))
    const profile = Array.isArray(bootstrap.servers)
        ? bootstrap.servers.find(server => server.id === build.profileId)
        : null
    if(profile == null) {
        throw new Error(`Packaged bootstrap distribution is missing ${build.profileId}`)
    }
    if(fs.statSync(installerPath).size === 0) {
        throw new Error(`Channel installer is empty: ${installerPath}`)
    }

    return { installerPath, channelPath, bootstrapPath }
}

function buildInstaller(apiBase, build) {
    const node = process.execPath
    const cli = path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
    const toolDirectory = path.join(root, 'dist', 'channel-tools')
    fs.rmSync(toolDirectory, { recursive: true, force: true })
    fs.mkdirSync(toolDirectory, { recursive: true })
    fs.writeFileSync(
        path.join(toolDirectory, 'npm.cmd'),
        `@echo off\r\n"${node}" "${path.join(root, 'scripts', 'npm-list-shim.js')}" %*\r\n`,
        'utf8'
    )
    fs.rmSync(outputRoot, { recursive: true, force: true })
    const result = spawnSync(node, [cli, '--config', 'electron-builder.channel.yml', '--win', 'nsis', '--x64'], {
        cwd: root,
        env: { ...process.env, PATH: `${toolDirectory}${path.delimiter}${process.env.PATH || ''}` },
        stdio: 'inherit'
    })
    if(result.error) throw result.error
    if(result.status !== 0) throw new Error(`electron-builder exited with code ${result.status}`)
    const parsedApi = new URL(apiBase)
    if(parsedApi.protocol !== 'https:') {
        fs.writeFileSync(
            path.join(outputRoot, 'DO-NOT-DISTRIBUTE-LOCAL-API.txt'),
            `This verification build points to ${apiBase}. Rebuild with the managed HTTPS API before distribution.\r\n`,
            'utf8'
        )
    }
    return verifyOutput(apiBase, build)
}

function main() {
    const args = parseArgs(process.argv)
    const apiBase = validateApiBase(args['api-url'] || process.env.COBBLEPOWER_API_BASE_URL || '')
    const build = prepare(apiBase)
    const output = args['prepare-only'] ? null : buildInstaller(apiBase, build)
    console.log(`Prepared authenticated channel launcher ${build.launcherVersion} for ${apiBase}`)
    if(output != null) console.log(`Verified installer: ${output.installerPath}`)
}

if(require.main === module) {
    try { main() } catch(err) {
        console.error(err.message || err)
        process.exitCode = 1
    }
}

module.exports = { parseArgs, prepare, validateApiBase, verifyOutput }
