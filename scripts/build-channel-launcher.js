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

function buildInstaller(apiBase) {
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
}

function main() {
    const args = parseArgs(process.argv)
    const apiBase = validateApiBase(args['api-url'] || process.env.COBBLEPOWER_API_BASE_URL || '')
    const build = prepare(apiBase)
    if(!args['prepare-only']) buildInstaller(apiBase)
    console.log(`Prepared authenticated channel launcher ${build.launcherVersion} for ${apiBase}`)
}

if(require.main === module) {
    try { main() } catch(err) {
        console.error(err.message || err)
        process.exitCode = 1
    }
}

module.exports = { parseArgs, prepare, validateApiBase }
