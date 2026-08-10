'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { finished } = require('stream/promises')
const AdmZip = require('adm-zip')
const semver = require('semver')
const toml = require('toml')

const { runPack, writeJsonAtomic } = require('./pack-generator')

const RELEASE_SCHEMA_VERSION = 1
const PACK_ROOT = path.resolve(__dirname, '..', '..')
const SAFE_RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function stableJson(value) {
    return `${JSON.stringify(value, null, 4)}\n`
}

async function hashFile(filePath) {
    const md5 = crypto.createHash('md5')
    const sha256 = crypto.createHash('sha256')
    let size = 0
    const stream = fs.createReadStream(filePath)
    stream.on('data', chunk => {
        size += chunk.length
        md5.update(chunk)
        sha256.update(chunk)
    })
    await finished(stream)
    return { size, md5: md5.digest('hex'), sha256: sha256.digest('hex') }
}

function parseModMetadata(jarPath) {
    const archive = new AdmZip(jarPath)
    const entry = archive.getEntry('META-INF/neoforge.mods.toml')
    if(!entry) throw new Error('Mod JAR is missing META-INF/neoforge.mods.toml')
    const metadata = toml.parse(archive.readAsText(entry))
    const mod = Array.isArray(metadata.mods) ? metadata.mods.find(candidate => candidate.modId === 'cobblepower') : null
    if(!mod) throw new Error('Mod JAR does not declare modId cobblepower')
    return { metadata, mod }
}

function validateVersionAgreement({ version, tag, metadata, sourceRepo }) {
    if(!semver.valid(version) || !semver.prerelease(version)) {
        throw new Error('Cobble Power test releases must use a valid unique SemVer prerelease (for example 1.0.1-test.1)')
    }
    if(tag !== `v${version}`) throw new Error(`Git tag must be v${version}`)
    if(String(metadata.mod.version) !== version) throw new Error(`NeoForge metadata version ${metadata.mod.version} does not match ${version}`)
    if(sourceRepo) {
        const propertiesPath = path.resolve(sourceRepo, 'gradle.properties')
        const properties = fs.readFileSync(propertiesPath, 'utf8')
        const match = properties.match(/^mod_version\s*=\s*(.+)$/m)
        if(!match || match[1].trim() !== version) throw new Error(`gradle.properties mod_version must be ${version}`)
    }
}

function validateCompatibility(metadata, packManifest) {
    const dependencies = metadata.metadata?.dependencies?.cobblepower || []
    const minecraft = dependencies.find(dep => dep.modId === 'minecraft')
    const neoforge = dependencies.find(dep => dep.modId === 'neoforge')
    if(!minecraft || !String(minecraft.versionRange || '').includes(packManifest.pack.minecraftVersion)) {
        throw new Error(`Cobble Power metadata must support Minecraft ${packManifest.pack.minecraftVersion}`)
    }
    const loaderMajorMinor = packManifest.pack.loader.version.split('.').slice(0, 2).join('.')
    if(!neoforge || !String(neoforge.versionRange || '').includes(loaderMajorMinor)) {
        throw new Error(`Cobble Power metadata must support NeoForge ${packManifest.pack.loader.version}`)
    }
}

function seedCache(filePath, integrity, cacheDir) {
    fs.mkdirSync(cacheDir, { recursive: true })
    const target = path.join(cacheDir, integrity.sha256)
    if(!fs.existsSync(target)) fs.copyFileSync(filePath, target)
    return target
}

function walkModules(modules, callback) {
    for(const module of modules || []) {
        callback(module)
        walkModules(module.subModules, callback)
    }
}

function replaceModuleUrl(distribution, moduleId, objectKey) {
    let count = 0
    for(const server of distribution.servers || []) {
        walkModules(server.modules, module => {
            if(module.id === moduleId) {
                module.artifact.url = `r2://${objectKey}`
                count++
            }
        })
    }
    if(count !== 1) throw new Error(`Expected exactly one distribution module ${moduleId}, found ${count}`)
}

function assertOutputDirectory(outputDir) {
    const resolved = path.resolve(outputDir)
    const distRoot = path.join(PACK_ROOT, 'dist') + path.sep
    if(!resolved.startsWith(distRoot)) throw new Error(`Prepared output must stay inside ${distRoot}`)
    return resolved
}

function copyObject(tempRoot, objectKey, sourcePath) {
    const destination = path.join(tempRoot, 'objects', ...objectKey.split('/'))
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(sourcePath, destination)
    return path.relative(tempRoot, destination).replace(/\\/g, '/')
}

function createDistributionBase() {
    return {
        version: '1.0.0',
        rss: 'https://helios-files.geekcorner.eu.org/rss.xml',
        servers: []
    }
}

async function prepareRelease(options) {
    const modPath = path.resolve(options.modPath)
    if(!fs.existsSync(modPath)) throw new Error(`Mod JAR does not exist: ${modPath}`)
    const version = String(options.modVersion || '').trim()
    const releaseId = String(options.releaseId || `cobble-power-${version}`).trim()
    if(!SAFE_RELEASE_ID.test(releaseId)) throw new Error('releaseId contains invalid characters')
    const channel = String(options.channel || 'test').trim().toLowerCase()
    if(channel !== 'test') throw new Error('Only the test channel is currently supported')
    const tag = String(options.sourceTag || '').trim()
    const commit = String(options.sourceCommit || '').trim().toLowerCase()
    if(!/^[a-f0-9]{40}$/.test(commit)) throw new Error('sourceCommit must be a full 40-character Git commit')
    const sourceRepository = String(options.sourceRepository || '').trim()
    if(!sourceRepository) throw new Error('sourceRepository is required')

    const baseManifestPath = path.resolve(options.packManifestPath || path.join(PACK_ROOT, 'packs', 'cobble-power-1.21.1.json'))
    const baseManifest = readJson(baseManifestPath)
    const parsedMetadata = parseModMetadata(modPath)
    validateVersionAgreement({ version, tag, metadata: parsedMetadata, sourceRepo: options.sourceRepo })
    validateCompatibility(parsedMetadata, baseManifest)
    const modIntegrity = await hashFile(modPath)

    const outputDir = assertOutputDirectory(options.outputDir || path.join(PACK_ROOT, 'dist', 'release-prepared', releaseId))
    const tempRoot = `${outputDir}.${process.pid}.${Date.now()}.tmp`
    fs.rmSync(tempRoot, { recursive: true, force: true })
    fs.mkdirSync(tempRoot, { recursive: true })
    try {
        const cacheDir = path.resolve(options.cacheDir || path.join(PACK_ROOT, 'deps', 'mod-cache'))
        seedCache(modPath, modIntegrity, cacheDir)
        const manifest = JSON.parse(JSON.stringify(baseManifest))
        manifest.pack.version = String(options.packVersion || version)
        manifest.pack.name = 'Cobble Power Test (Minecraft 1.21.1)'
        manifest.pack.description = `Private Cobble Power ${version} test channel.`
        const modId = `net.allegator.cobblepower:cobblepower:${version}`
        manifest.modules.push({
            id: modId,
            name: `Cobble Power ${version}`,
            version,
            type: 'ForgeMod',
            role: 'required',
            required: true,
            side: 'both',
            order: 50,
            minecraftVersion: manifest.pack.minecraftVersion,
            loader: 'neoforge',
            expectedSha256: modIntegrity.sha256,
            expectedSize: modIntegrity.size,
            source: { type: 'direct', url: `https://publisher.invalid/cobblepower-${version}.jar` }
        })

        const manifestPath = path.join(tempRoot, 'pack-manifest.json')
        const distributionPath = path.join(tempRoot, 'distribution-template.json')
        const lockPath = path.join(tempRoot, 'pack.lock.json')
        writeJsonAtomic(manifestPath, manifest)
        writeJsonAtomic(distributionPath, createDistributionBase())
        await runPack({ pack: manifestPath, distro: distributionPath, lock: lockPath, cache: cacheDir, quiet: true })

        const distribution = readJson(distributionPath)
        const cobblemon = readJson(lockPath).artifacts.find(artifact => artifact.id.startsWith('com.cobblemon:neoforge:'))
        if(!cobblemon) throw new Error('Pack lock does not contain the required Cobblemon artifact')
        const cobblemonKey = `third-party/com/cobblemon/neoforge/${cobblemon.version}/neoforge-${cobblemon.version}.jar`
        const modObjectKey = `maven/net/allegator/cobblepower/cobblepower/${version}/cobblepower-${version}.jar`
        replaceModuleUrl(distribution, cobblemon.id, cobblemonKey)
        replaceModuleUrl(distribution, modId, modObjectKey)
        writeJsonAtomic(distributionPath, distribution)

        const cobblemonCachePath = path.join(cacheDir, cobblemon.integrity.sha256)
        if(!fs.existsSync(cobblemonCachePath)) throw new Error('Locked Cobblemon snapshot is missing from the checksum cache')
        const objects = [
            { key: modObjectKey, sourcePath: modPath, integrity: modIntegrity, contentType: 'application/java-archive' },
            { key: cobblemonKey, sourcePath: cobblemonCachePath, integrity: cobblemon.integrity, contentType: 'application/java-archive' }
        ].sort((a, b) => a.key.localeCompare(b.key))
        for(const object of objects) object.file = copyObject(tempRoot, object.key, object.sourcePath)

        const lock = readJson(lockPath)
        const privateKeys = new Map([[modId, modObjectKey], [cobblemon.id, cobblemonKey]])
        const noticeSource = path.resolve(PACK_ROOT, cobblemon.provenance?.notice || '')
        if(!cobblemon.provenance?.license || !cobblemon.provenance?.sourceUrl || !cobblemon.provenance?.commit || !fs.existsSync(noticeSource)) {
            throw new Error('Cobblemon mirror provenance and license notice are required')
        }
        const noticeFile = 'THIRD-PARTY-NOTICES.md'
        fs.copyFileSync(noticeSource, path.join(tempRoot, noticeFile))
        const noticeIntegrity = await hashFile(path.join(tempRoot, noticeFile))
        const noticeKey = `channels/${channel}/releases/${releaseId}/${noticeFile}`
        const descriptor = {
            schemaVersion: RELEASE_SCHEMA_VERSION,
            releaseId,
            channel,
            packVersion: manifest.pack.version,
            modVersion: version,
            source: { repository: sourceRepository, tag, commit },
            createdAt: options.createdAt || new Date().toISOString(),
            notices: [{
                name: 'Cobblemon',
                license: cobblemon.provenance.license,
                sourceUrl: cobblemon.provenance.sourceUrl,
                sourceCommit: cobblemon.provenance.commit,
                objectKey: noticeKey,
                ...noticeIntegrity
            }],
            modules: lock.artifacts.map(module => ({
                id: module.id,
                name: module.name,
                version: module.version,
                role: module.role,
                required: module.required,
                objectKey: privateKeys.get(module.id) || null,
                sourceUrl: privateKeys.has(module.id) ? null : module.source?.url || null,
                size: module.integrity.size,
                md5: module.integrity.md5,
                sha256: module.integrity.sha256,
                provenance: module.provenance || null
            })).sort((a, b) => a.id.localeCompare(b.id))
        }
        writeJsonAtomic(path.join(tempRoot, 'release.json'), descriptor)

        const templateKey = `channels/${channel}/releases/${releaseId}/distribution-template.json`
        const descriptorKey = `channels/${channel}/releases/${releaseId}/release.json`
        const stateObjects = objects.map(object => ({
            key: object.key,
            file: object.file,
            ...object.integrity,
            contentType: object.contentType
        }))
        stateObjects.push({
            key: noticeKey,
            file: noticeFile,
            contentType: 'text/markdown; charset=utf-8',
            ...noticeIntegrity
        })
        for(const item of [
            { key: templateKey, file: 'distribution-template.json', contentType: 'application/json' },
            { key: descriptorKey, file: 'release.json', contentType: 'application/json' }
        ]) {
            const integrity = await hashFile(path.join(tempRoot, item.file))
            stateObjects.push({ ...item, ...integrity })
        }
        writeJsonAtomic(path.join(tempRoot, 'publish-state.json'), {
            schemaVersion: RELEASE_SCHEMA_VERSION,
            releaseId,
            channel,
            templateKey,
            descriptorKey,
            expectedPreviousReleaseId: options.expectedPreviousReleaseId || null,
            objects: stateObjects.sort((a, b) => a.key.localeCompare(b.key))
        })

        fs.rmSync(outputDir, { recursive: true, force: true })
        fs.mkdirSync(path.dirname(outputDir), { recursive: true })
        fs.renameSync(tempRoot, outputDir)
        return { outputDir, descriptor, state: readJson(path.join(outputDir, 'publish-state.json')) }
    } catch(err) {
        fs.rmSync(tempRoot, { recursive: true, force: true })
        throw err
    }
}

function loadPrepared(preparedDir) {
    const root = path.resolve(preparedDir)
    const state = readJson(path.join(root, 'publish-state.json'))
    if(state.schemaVersion !== RELEASE_SCHEMA_VERSION || !SAFE_RELEASE_ID.test(state.releaseId)) {
        throw new Error('Prepared release state is invalid')
    }
    for(const object of state.objects || []) {
        const filePath = path.resolve(root, object.file)
        if(filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) throw new Error('Prepared object path escapes its root')
        object.filePath = filePath
    }
    return { root, state }
}

module.exports = {
    RELEASE_SCHEMA_VERSION,
    hashFile,
    loadPrepared,
    parseModMetadata,
    prepareRelease,
    replaceModuleUrl,
    stableJson,
    validateCompatibility,
    validateVersionAgreement
}
