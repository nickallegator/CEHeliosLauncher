'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const AdmZip = require('adm-zip')
const toml = require('toml')

const { runPack, writeJsonAtomic } = require('./lib/pack-generator')

const projectRoot = path.resolve(__dirname, '..')
const releasePath = path.join(projectRoot, 'packs', 'cobble-power-tester-release.json')
const baseManifestPath = path.join(projectRoot, 'packs', 'cobble-power-1.21.1.json')
const stagingRoot = path.join(projectRoot, 'dist', 'tester-staging')
const testerRoot = path.join(stagingRoot, 'tester')
const outputRoot = path.join(projectRoot, 'dist', 'tester-output')

function parseArgs(argv) {
    const args = {}
    for(let index = 2; index < argv.length; index++){
        const token = argv[index]
        if(!token.startsWith('--')){
            throw new Error(`Unexpected argument: ${token}`)
        }
        const key = token.slice(2)
        const next = argv[index + 1]
        if(next == null || next.startsWith('--')){
            args[key] = true
        } else {
            args[key] = next
            index++
        }
    }
    return args
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function digest(filePath, algorithm) {
    return crypto.createHash(algorithm).update(fs.readFileSync(filePath)).digest('hex')
}

function assertSafeGeneratedDirectory(directory) {
    const resolved = path.resolve(directory)
    const expectedRoot = path.join(projectRoot, 'dist') + path.sep
    if(!resolved.startsWith(expectedRoot)){
        throw new Error(`Refusing to replace generated directory outside ${expectedRoot}`)
    }
}

function validateModArtifact(modPath, release) {
    if(!fs.existsSync(modPath)){
        throw new Error(`Cobble Power mod JAR is missing: ${modPath}`)
    }
    const size = fs.statSync(modPath).size
    const md5 = digest(modPath, 'md5')
    const sha256 = digest(modPath, 'sha256')
    if(size !== release.mod.expectedSize
        || md5 !== release.mod.expectedMd5
        || sha256 !== release.mod.expectedSha256){
        throw new Error([
            'Cobble Power mod JAR does not match the locked tester release.',
            `Expected ${release.mod.expectedSize} bytes / ${release.mod.expectedSha256}.`,
            `Received ${size} bytes / ${sha256}.`
        ].join(' '))
    }

    const archive = new AdmZip(modPath)
    const metadataEntry = archive.getEntry('META-INF/neoforge.mods.toml')
    if(metadataEntry == null){
        throw new Error('Cobble Power mod JAR is missing META-INF/neoforge.mods.toml')
    }
    const metadata = toml.parse(archive.readAsText(metadataEntry))
    const declaredMod = Array.isArray(metadata.mods)
        ? metadata.mods.find(candidate => candidate.modId === 'cobblepower')
        : null
    if(declaredMod == null || String(declaredMod.version) !== release.mod.version){
        throw new Error(`Cobble Power metadata must declare version ${release.mod.version}`)
    }
    return { md5, sha256, size }
}

function mavenRelativePath(identifier) {
    const parts = identifier.split(':')
    if(parts.length !== 3){
        throw new Error(`Tester mod identifier must contain group, artifact, and version: ${identifier}`)
    }
    const [group, artifact, version] = parts
    return path.join(
        ...group.split('.'),
        artifact,
        version,
        `${artifact}-${version}.jar`
    )
}

function prepareCache(modPath, integrity) {
    const cacheDirectory = path.join(projectRoot, 'deps', 'mod-cache')
    const cachePath = path.join(cacheDirectory, integrity.sha256)
    fs.mkdirSync(cacheDirectory, { recursive: true })
    if(fs.existsSync(cachePath) && digest(cachePath, 'sha256') === integrity.sha256){
        return cachePath
    }
    fs.copyFileSync(modPath, cachePath)
    if(digest(cachePath, 'sha256') !== integrity.sha256){
        throw new Error('Unable to seed the verified pack-generator cache')
    }
    return cachePath
}

function createTestManifest(baseManifest, release) {
    const manifest = JSON.parse(JSON.stringify(baseManifest))
    manifest.pack.name = release.profileName
    manifest.pack.description = release.profileDescription
    manifest.pack.version = release.profileVersion
    manifest.modules.push({
        id: release.mod.id,
        name: release.mod.name,
        version: release.mod.version,
        type: 'ForgeMod',
        role: 'required',
        required: true,
        side: 'both',
        order: 50,
        minecraftVersion: manifest.pack.minecraftVersion,
        loader: 'neoforge',
        expectedSha256: release.mod.expectedSha256,
        expectedSize: release.mod.expectedSize,
        source: {
            type: 'direct',
            url: release.mod.publicUrl
        }
    })
    return manifest
}

function createDistributionBase() {
    return {
        version: '1.0.0',
        rss: 'https://helios-files.geekcorner.eu.org/rss.xml',
        discord: {
            clientId: '1086936373057040395',
            smallImageText: 'Cobble Power Test',
            smallImageKey: 'big'
        },
        servers: []
    }
}

async function prepareTesterFiles(args) {
    const release = readJson(releasePath)
    let configuredModPath = args.mod
        ? path.resolve(args.mod)
        : path.resolve(projectRoot, release.mod.sourcePath)
    let integrity
    try {
        integrity = validateModArtifact(configuredModPath, release)
    } catch(err) {
        const lockedCachePath = path.join(projectRoot, 'deps', 'mod-cache', release.mod.expectedSha256)
        if(args.mod || !fs.existsSync(lockedCachePath)){
            throw err
        }
        console.warn('Configured mod JAR changed; rebuilding from the immutable verified cache.')
        configuredModPath = lockedCachePath
        integrity = validateModArtifact(configuredModPath, release)
    }
    prepareCache(configuredModPath, integrity)

    assertSafeGeneratedDirectory(stagingRoot)
    fs.rmSync(stagingRoot, { recursive: true, force: true })
    fs.mkdirSync(testerRoot, { recursive: true })

    const manifestPath = path.join(stagingRoot, 'cobble-power-test-manifest.json')
    const distributionPath = path.join(testerRoot, 'distribution_test.json')
    const lockPath = path.join(projectRoot, 'packs', 'locks', 'cobble-power-tester.lock.json')
    const manifest = createTestManifest(readJson(baseManifestPath), release)
    writeJsonAtomic(manifestPath, manifest)
    writeJsonAtomic(distributionPath, createDistributionBase())

    await runPack({
        pack: manifestPath,
        distro: distributionPath,
        lock: lockPath,
        cache: path.join(projectRoot, 'deps', 'mod-cache'),
        quiet: true
    })

    const artifactRelativePath = path.join('artifacts', path.basename(configuredModPath))
    const bundledArtifactPath = path.join(testerRoot, artifactRelativePath)
    fs.mkdirSync(path.dirname(bundledArtifactPath), { recursive: true })
    fs.copyFileSync(configuredModPath, bundledArtifactPath)

    const destination = path.join('common', 'modstore', mavenRelativePath(release.mod.id))
    writeJsonAtomic(path.join(testerRoot, 'tester-channel.json'), {
        schemaVersion: 1,
        id: release.channelId,
        name: release.channelName,
        distribution: 'distribution_test.json',
        artifacts: [{
            id: release.mod.id,
            source: artifactRelativePath.replace(/\\/g, '/'),
            destination: destination.replace(/\\/g, '/'),
            size: integrity.size,
            md5: integrity.md5,
            sha256: integrity.sha256
        }]
    })

    return { integrity, release }
}

function buildInstaller() {
    const toolDirectory = path.join(projectRoot, 'dist', 'tester-tools')
    assertSafeGeneratedDirectory(toolDirectory)
    fs.rmSync(toolDirectory, { recursive: true, force: true })
    fs.mkdirSync(toolDirectory, { recursive: true })
    const npmShimPath = path.join(toolDirectory, 'npm.cmd')
    fs.writeFileSync(
        npmShimPath,
        `@echo off\r\n"${process.execPath}" "${path.join(projectRoot, 'scripts', 'npm-list-shim.js')}" %*\r\n`,
        'utf8'
    )

    const electronBuilderCli = path.join(
        projectRoot,
        'node_modules',
        'electron-builder',
        'out',
        'cli',
        'cli.js'
    )
    const result = spawnSync(process.execPath, [
        electronBuilderCli,
        '--config',
        'electron-builder.test.yml',
        '--win',
        'nsis',
        '--x64'
    ], {
        cwd: projectRoot,
        env: {
            ...process.env,
            PATH: `${toolDirectory}${path.delimiter}${process.env.PATH || ''}`
        },
        stdio: 'inherit'
    })
    if(result.error){
        throw result.error
    }
    if(result.status !== 0){
        throw new Error(`electron-builder exited with code ${result.status}`)
    }
}

function finalizeRelease(release, integrity) {
    const installerName = `AG-Launcher-Standalone-Test-setup-${release.launcherVersion}.exe`
    const installerPath = path.join(outputRoot, installerName)
    if(!fs.existsSync(installerPath)){
        throw new Error(`Expected tester installer was not produced: ${installerName}`)
    }

    const installerSha256 = digest(installerPath, 'sha256')
    const installerSize = fs.statSync(installerPath).size
    const releaseOutputRoot = path.join(projectRoot, 'dist', `Cobble-Power-Tester-${release.profileVersion}`)
    assertSafeGeneratedDirectory(releaseOutputRoot)
    fs.rmSync(releaseOutputRoot, { recursive: true, force: true })
    fs.mkdirSync(releaseOutputRoot, { recursive: true })
    const releaseInstallerPath = path.join(releaseOutputRoot, path.basename(installerPath))
    fs.copyFileSync(installerPath, releaseInstallerPath)
    fs.writeFileSync(
        path.join(releaseOutputRoot, 'SHA256SUMS.txt'),
        `${installerSha256}  ${path.basename(installerPath)}\n`,
        'utf8'
    )
    fs.writeFileSync(
        path.join(releaseOutputRoot, 'TESTER-INSTRUCTIONS.txt'),
        [
            'COBBLE POWER PRIVATE TEST',
            '',
            '1. Run the Allegator Games Launcher installer.',
            '2. Windows SmartScreen may warn because this private test build is unsigned.',
            '3. Sign in with a Microsoft account that owns Minecraft Java Edition.',
            '4. Select Cobble Power Test and press Play. Java and the mod pack install automatically.',
            '5. In Minecraft, use Multiplayer > Add Server and enter the address supplied by the test host.',
            '',
            'Do not redistribute this private test build outside the testing group.',
            'When reporting a problem, include the latest.log file from:',
            '  %APPDATA%\\.ag-launcher\\instances\\Cobble-Power-1.21.1\\logs\\latest.log',
            ''
        ].join('\r\n'),
        'utf8'
    )
    writeJsonAtomic(path.join(releaseOutputRoot, 'release-manifest.json'), {
        schemaVersion: 1,
        channel: release.channelId,
        launcherVersion: release.launcherVersion,
        profileVersion: release.profileVersion,
        installer: {
            file: path.basename(installerPath),
            size: installerSize,
            sha256: installerSha256
        },
        mod: {
            id: release.mod.id,
            size: integrity.size,
            md5: integrity.md5,
            sha256: integrity.sha256
        }
    })
    return { installerPath: releaseInstallerPath, installerSha256, installerSize }
}

async function main() {
    const args = parseArgs(process.argv)
    if(args['finalize-only']){
        const release = readJson(releasePath)
        const result = finalizeRelease(release, {
            size: release.mod.expectedSize,
            md5: release.mod.expectedMd5,
            sha256: release.mod.expectedSha256
        })
        console.log(`Tester release folder: ${path.dirname(result.installerPath)}`)
        console.log(`SHA-256: ${result.installerSha256}`)
        return
    }
    const prepared = await prepareTesterFiles(args)
    if(args['prepare-only']){
        console.log(`Prepared tester channel at ${testerRoot}`)
        return
    }
    buildInstaller()
    const result = finalizeRelease(prepared.release, prepared.integrity)
    console.log(`Tester installer: ${result.installerPath}`)
    console.log(`SHA-256: ${result.installerSha256}`)
}

if(require.main === module){
    main().catch(err => {
        console.error(err?.stack || err)
        process.exitCode = 1
    })
}

module.exports = {
    createTestManifest,
    mavenRelativePath,
    prepareTesterFiles,
    validateModArtifact
}
