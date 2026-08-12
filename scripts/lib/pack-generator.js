'use strict'

const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const https = require('https')
const path = require('path')
const { finished } = require('stream/promises')

const DEFAULT_CACHE_DIR = path.resolve('deps', 'mod-cache')
const DEFAULT_CONCURRENCY = 4
const DEFAULT_CURSE_BASE = 'https://www.cursemaven.com/curse/maven'
const DEFAULT_MAVEN_BASE = 'https://repo1.maven.org/maven2'
const DEFAULT_MODRINTH_API = 'https://api.modrinth.com/v2'
const DEFAULT_RETRIES = 2
const DEFAULT_TIMEOUT_MS = 30000
const PACK_SCHEMA_VERSION = 1
const VALID_MODULE_SIDES = new Set(['both', 'client', 'server'])
const VALID_MODULE_TYPES = new Set(['ForgeMod', 'FabricMod', 'LiteMod', 'Library', 'File'])
const VALID_SOURCE_TYPES = new Set(['direct', 'maven', 'cursemaven', 'modrinth'])

function usage() {
    const msg = `\
Usage:
  node scripts/generate-modules.js --pack <pack.json> [--distro <distribution_dev.json>] [--lock <pack.lock.json>]
  node scripts/generate-modules.js --pack <pack.json> --distro <distribution_dev.json> --lock <pack.lock.json> --check
  node scripts/generate-modules.js --mods <mods.json> [--out <modules.json>]
  node scripts/generate-modules.js --mods <mods.json> --distro <distribution_dev.json> --server <serverId>

Pack options:
  --pack         Versioned pack manifest.
  --distro       Distribution file to create or update atomically.
  --lock         Deterministic lock file containing resolved hashes and sizes.
  --out          Optional modules-only JSON output.
  --check        Validate artifacts and require generated output to be current; write nothing.
  --cache        Artifact cache directory (default ${DEFAULT_CACHE_DIR}).
  --concurrency  Maximum simultaneous artifact resolutions (default ${DEFAULT_CONCURRENCY}).
  --retries      Network retry count after the first attempt (default ${DEFAULT_RETRIES}).
  --timeout      Per-request timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}).

Legacy options:
  --mods         Legacy mods list JSON (see scripts/mods.example.json).
  --server       Server id to patch in a distribution.
  --base         Curse Maven base URL (default ${DEFAULT_CURSE_BASE}).
  --maven        Maven base URL (default ${DEFAULT_MAVEN_BASE}).
  --modrinthApi  Modrinth API URL (default ${DEFAULT_MODRINTH_API}).
  --createServer Create a missing legacy server (true/false).
  --overwriteServer Replace an existing legacy server (true/false).
  --loader       Loader for a new legacy server (neoforge only).
  --loaderVersion NeoForge version for a new legacy server.
  --minecraftVersion Minecraft version for a new legacy server.
`
    console.log(msg)
}

function parseArgs(argv) {
    const args = {}
    for (let i = 2; i < argv.length; i++) {
        const token = argv[i]
        if (!token || !token.startsWith('--')) {
            throw new Error(`Unexpected argument: ${token || ''}`)
        }
        const key = token.slice(2)
        const next = argv[i + 1]
        if (next == null || next.startsWith('--')) {
            args[key] = true
        } else {
            args[key] = next
            i++
        }
    }
    return args
}

function asBoolean(value) {
    return value === true || String(value).toLowerCase() === 'true'
}

function isObject(value) {
    return value != null && typeof value === 'object' && !Array.isArray(value)
}

function requireString(value, label) {
    const normalized = String(value == null ? '' : value).trim()
    if (!normalized) {
        throw new Error(`${label} is required`)
    }
    return normalized
}

function validateHttpUrl(value, label) {
    const normalized = requireString(value, label)
    let parsed
    try {
        parsed = new URL(normalized)
    } catch (_err) {
        throw new Error(`${label} must be a valid URL`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`${label} must use http or https`)
    }
    return normalized
}

function normalizeSha256(value, label) {
    const normalized = requireString(value, label).toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(normalized)) {
        throw new Error(`${label} must be a 64-character SHA-256 digest`)
    }
    return normalized
}

function validateExpectedSize(value, label) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive integer`)
    }
    return value
}

function validateMavenId(id, label) {
    const normalized = requireString(id, label)
    if (normalized.split(':').length < 3) {
        throw new Error(`${label} must be a Maven-style identifier`)
    }
    return normalized
}

function validateSource(source, label) {
    if (!isObject(source)) {
        throw new Error(`${label} must be an object`)
    }
    const type = requireString(source.type, `${label}.type`).toLowerCase()
    if (!VALID_SOURCE_TYPES.has(type)) {
        throw new Error(`${label}.type is unsupported: ${type}`)
    }
    if (type === 'direct') {
        validateHttpUrl(source.url, `${label}.url`)
    } else if (type === 'maven') {
        requireString(source.group, `${label}.group`)
        requireString(source.artifact, `${label}.artifact`)
        requireString(source.version, `${label}.version`)
        if (source.base != null) {
            validateHttpUrl(source.base, `${label}.base`)
        }
    } else if (type === 'cursemaven') {
        requireString(source.projectId, `${label}.projectId`)
        requireString(source.fileId, `${label}.fileId`)
        if (source.base != null) {
            validateHttpUrl(source.base, `${label}.base`)
        }
    } else if (type === 'modrinth') {
        requireString(source.versionId, `${label}.versionId`)
        if (source.api != null) {
            validateHttpUrl(source.api, `${label}.api`)
        }
    }
}

function validatePackManifest(manifest) {
    if (!isObject(manifest)) {
        throw new Error('Pack manifest must be a JSON object')
    }
    if (manifest.schemaVersion !== PACK_SCHEMA_VERSION) {
        throw new Error(`Unsupported pack schemaVersion: ${manifest.schemaVersion}`)
    }
    if (!isObject(manifest.pack)) {
        throw new Error('pack must be an object')
    }

    const pack = manifest.pack
    requireString(pack.id, 'pack.id')
    requireString(pack.name, 'pack.name')
    requireString(pack.description, 'pack.description')
    requireString(pack.version, 'pack.version')
    requireString(pack.minecraftVersion, 'pack.minecraftVersion')
    requireString(pack.address, 'pack.address')
    validateHttpUrl(pack.icon, 'pack.icon')
    if (typeof pack.mainServer !== 'boolean' || typeof pack.autoconnect !== 'boolean') {
        throw new Error('pack.mainServer and pack.autoconnect must be booleans')
    }
    if (!isObject(pack.javaOptions)) {
        throw new Error('pack.javaOptions must be an object')
    }
    requireString(pack.javaOptions.distribution, 'pack.javaOptions.distribution')
    requireString(pack.javaOptions.supported, 'pack.javaOptions.supported')
    if (!Number.isInteger(pack.javaOptions.suggestedMajor) || pack.javaOptions.suggestedMajor <= 0) {
        throw new Error('pack.javaOptions.suggestedMajor must be a positive integer')
    }
    if (!isObject(pack.javaOptions.ram)) {
        throw new Error('pack.javaOptions.ram must be an object')
    }
    validateExpectedSize(pack.javaOptions.ram.minimum, 'pack.javaOptions.ram.minimum')
    validateExpectedSize(pack.javaOptions.ram.recommended, 'pack.javaOptions.ram.recommended')
    if (pack.javaOptions.ram.recommended < pack.javaOptions.ram.minimum) {
        throw new Error('Recommended RAM cannot be lower than minimum RAM')
    }

    if (!isObject(pack.loader)) {
        throw new Error('pack.loader must be an object')
    }
    if (requireString(pack.loader.type, 'pack.loader.type').toLowerCase() !== 'neoforge') {
        throw new Error('Only the neoforge pack loader is currently supported')
    }
    requireString(pack.loader.version, 'pack.loader.version')
    normalizeSha256(pack.loader.expectedSha256, 'pack.loader.expectedSha256')
    validateExpectedSize(pack.loader.expectedSize, 'pack.loader.expectedSize')
    validateSource(pack.loader.source, 'pack.loader.source')
    if (pack.futureModuleId != null) {
        validateMavenId(pack.futureModuleId, 'pack.futureModuleId')
    }

    if (!Array.isArray(manifest.modules) || manifest.modules.length === 0) {
        throw new Error('modules must be a non-empty array')
    }

    const ids = new Set()
    for (const [index, module] of manifest.modules.entries()) {
        const label = `modules[${index}]`
        if (!isObject(module)) {
            throw new Error(`${label} must be an object`)
        }
        const id = validateMavenId(module.id, `${label}.id`)
        if (ids.has(id)) {
            throw new Error(`Duplicate module id: ${id}`)
        }
        ids.add(id)
        requireString(module.name, `${label}.name`)
        requireString(module.version, `${label}.version`)
        const type = requireString(module.type, `${label}.type`)
        if (!VALID_MODULE_TYPES.has(type)) {
            throw new Error(`${label}.type is unsupported: ${type}`)
        }
        const side = requireString(module.side, `${label}.side`).toLowerCase()
        if (!VALID_MODULE_SIDES.has(side)) {
            throw new Error(`${label}.side is unsupported: ${side}`)
        }
        const role = requireString(module.role, `${label}.role`).toLowerCase()
        if (role !== 'required' && role !== 'optional') {
            throw new Error(`${label}.role must be required or optional`)
        }
        if (typeof module.required !== 'boolean') {
            throw new Error(`${label}.required must be a boolean`)
        }
        if (role === 'required' && !module.required) {
            throw new Error(`${label} has a required role but is marked optional`)
        }
        if (role === 'optional' && module.required) {
            throw new Error(`${label} has an optional role but is marked required`)
        }
        if (!module.required && typeof module.defaultEnabled !== 'boolean') {
            throw new Error(`${label}.defaultEnabled must be a boolean for optional modules`)
        }
        if (module.required && module.defaultEnabled === false) {
            throw new Error(`${label} cannot disable a required module by default`)
        }
        if (!Number.isFinite(module.order)) {
            throw new Error(`${label}.order must be a number`)
        }
        if (module.minecraftVersion !== pack.minecraftVersion) {
            throw new Error(`${label}.minecraftVersion must match pack.minecraftVersion`)
        }
        if (String(module.loader).toLowerCase() !== 'neoforge') {
            throw new Error(`${label}.loader must be neoforge`)
        }
        normalizeSha256(module.expectedSha256, `${label}.expectedSha256`)
        validateExpectedSize(module.expectedSize, `${label}.expectedSize`)
        validateSource(module.source, `${label}.source`)
    }

    return manifest
}

function requestOnce(url, options = {}, redirects = 0) {
    const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS)
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https:') ? https : http
        const req = lib.get(url, {
            headers: {
                'User-Agent': 'AGLauncher-PackGenerator/1.0'
            }
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                if (redirects >= 5) {
                    res.resume()
                    reject(new Error(`Too many redirects for ${url}`))
                    return
                }
                const next = new URL(res.headers.location, url).toString()
                res.resume()
                resolve(requestOnce(next, options, redirects + 1))
                return
            }
            if (res.statusCode !== 200) {
                res.resume()
                reject(new Error(`Request failed ${res.statusCode} for ${url}`))
                return
            }
            resolve(res)
        })
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Request timed out after ${timeoutMs}ms for ${url}`))
        })
        req.on('error', reject)
    })
}

async function withRetries(operation, retries, onRetry) {
    let lastError
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await operation(attempt)
        } catch (err) {
            lastError = err
            if (attempt < retries && onRetry) {
                onRetry(err, attempt + 1)
            }
        }
    }
    throw lastError
}

async function fetchJson(url, options = {}) {
    const retries = Number(options.retries ?? DEFAULT_RETRIES)
    return withRetries(async () => {
        const res = await requestOnce(url, options)
        let data = ''
        res.setEncoding('utf8')
        for await (const chunk of res) {
            data += chunk
        }
        return JSON.parse(data)
    }, retries)
}

async function hashStream(stream, destinationPath) {
    const md5 = crypto.createHash('md5')
    const sha256 = crypto.createHash('sha256')
    const destination = destinationPath ? fs.createWriteStream(destinationPath, { flags: 'wx' }) : null
    let size = 0

    try {
        for await (const chunk of stream) {
            size += chunk.length
            md5.update(chunk)
            sha256.update(chunk)
            if (destination && !destination.write(chunk)) {
                await new Promise((resolve) => destination.once('drain', resolve))
            }
        }
        if (destination) {
            destination.end()
            await finished(destination)
        }
    } catch (err) {
        if (destination) {
            destination.destroy()
        }
        throw err
    }

    return {
        md5: md5.digest('hex'),
        sha256: sha256.digest('hex'),
        size
    }
}

async function hashFile(filePath) {
    return hashStream(fs.createReadStream(filePath))
}

function assertIntegrity(result, expectedSha256, expectedSize, label) {
    if (expectedSha256 && result.sha256.toLowerCase() !== expectedSha256.toLowerCase()) {
        throw new Error(`Checksum mismatch for ${label}: expected ${expectedSha256}, received ${result.sha256}`)
    }
    if (expectedSize && result.size !== expectedSize) {
        throw new Error(`Size mismatch for ${label}: expected ${expectedSize}, received ${result.size}`)
    }
    return result
}

function safelyRemoveCacheFile(filePath, cacheDir) {
    const resolvedCache = path.resolve(cacheDir)
    const resolvedFile = path.resolve(filePath)
    if (!resolvedFile.startsWith(`${resolvedCache}${path.sep}`)) {
        throw new Error(`Refusing to remove a cache file outside ${resolvedCache}`)
    }
    fs.rmSync(resolvedFile, { force: true })
}

async function downloadArtifact(url, options = {}) {
    const expectedSha256 = options.expectedSha256
        ? normalizeSha256(options.expectedSha256, 'expectedSha256')
        : null
    const expectedSize = options.expectedSize == null
        ? null
        : validateExpectedSize(options.expectedSize, 'expectedSize')
    const cacheDir = path.resolve(options.cacheDir || DEFAULT_CACHE_DIR)
    const retries = Number(options.retries ?? DEFAULT_RETRIES)
    const label = options.label || url

    if (expectedSha256) {
        fs.mkdirSync(cacheDir, { recursive: true })
        const cachePath = path.join(cacheDir, expectedSha256)
        if (fs.existsSync(cachePath)) {
            try {
                const result = assertIntegrity(await hashFile(cachePath), expectedSha256, expectedSize, label)
                return { ...result, cachePath, fromCache: true }
            } catch (_err) {
                safelyRemoveCacheFile(cachePath, cacheDir)
            }
        }

        return withRetries(async () => {
            const tempPath = path.join(cacheDir, `.${expectedSha256}.${process.pid}.${crypto.randomUUID()}.tmp`)
            try {
                const response = await requestOnce(url, options)
                const result = assertIntegrity(
                    await hashStream(response, tempPath),
                    expectedSha256,
                    expectedSize,
                    label
                )
                if (fs.existsSync(cachePath)) {
                    safelyRemoveCacheFile(tempPath, cacheDir)
                } else {
                    fs.renameSync(tempPath, cachePath)
                }
                return { ...result, cachePath, fromCache: false }
            } catch (err) {
                if (fs.existsSync(tempPath)) {
                    safelyRemoveCacheFile(tempPath, cacheDir)
                }
                throw err
            }
        }, retries, options.onRetry)
    }

    return withRetries(async () => {
        const response = await requestOnce(url, options)
        return hashStream(response)
    }, retries, options.onRetry)
}

function buildMavenUrl(base, group, artifact, version, classifier, extension) {
    const groupPath = group.replace(/\./g, '/')
    const suffix = classifier ? `-${classifier}` : ''
    const ext = extension || 'jar'
    return `${base.replace(/\/+$/, '')}/${groupPath}/${artifact}/${version}/${artifact}-${version}${suffix}.${ext}`
}

function buildMavenId(group, artifact, version, classifier, extension) {
    const ext = extension && extension !== 'jar' ? `@${extension}` : ''
    const cls = classifier ? `:${classifier}` : ''
    return `${group}:${artifact}:${version}${cls}${ext}`
}

async function resolveSource(source, args = {}) {
    const type = String(source.type).toLowerCase()
    if (type === 'direct') {
        return {
            type,
            url: String(source.url).trim()
        }
    }
    if (type === 'maven') {
        const group = String(source.group).trim()
        const artifact = String(source.artifact).trim()
        const version = String(source.version).trim()
        const classifier = source.classifier ? String(source.classifier).trim() : undefined
        const extension = source.extension ? String(source.extension).trim() : 'jar'
        const base = String(source.base || args.maven || DEFAULT_MAVEN_BASE).replace(/\/+$/, '')
        return {
            type,
            url: buildMavenUrl(base, group, artifact, version, classifier, extension),
            coordinate: buildMavenId(group, artifact, version, classifier, extension)
        }
    }
    if (type === 'cursemaven') {
        const projectId = String(source.projectId).trim()
        const fileId = String(source.fileId).trim()
        const base = String(source.base || args.base || DEFAULT_CURSE_BASE).replace(/\/+$/, '')
        return {
            type,
            url: `${base}/${projectId}/${fileId}/${projectId}-${fileId}.jar`,
            coordinate: `curse.maven:${projectId}:${fileId}`
        }
    }
    if (type === 'modrinth') {
        const versionId = String(source.versionId).trim()
        const api = String(source.api || args.modrinthApi || DEFAULT_MODRINTH_API).replace(/\/+$/, '')
        const version = await fetchJson(`${api}/version/${versionId}`, args)
        const files = Array.isArray(version.files) ? version.files : []
        if (files.length === 0) {
            throw new Error(`Modrinth version has no files: ${versionId}`)
        }
        const requestedIndex = source.fileIndex == null ? -1 : Number(source.fileIndex)
        const file = requestedIndex >= 0 && files[requestedIndex]
            ? files[requestedIndex]
            : files.find((candidate) => candidate.primary) || files[0]
        const projectId = source.projectId || version.project_id || 'modrinth'
        return {
            type,
            url: file.url,
            coordinate: `modrinth:${projectId}:${versionId}`
        }
    }
    throw new Error(`Unknown source type: ${type}`)
}

async function mapLimit(items, limit, worker) {
    const concurrency = Math.max(1, Math.min(Number(limit) || DEFAULT_CONCURRENCY, items.length || 1))
    const results = new Array(items.length)
    let nextIndex = 0

    async function runWorker() {
        while (nextIndex < items.length) {
            const index = nextIndex++
            results[index] = await worker(items[index], index)
        }
    }

    await Promise.all(Array.from({ length: concurrency }, () => runWorker()))
    return results
}

function orderedPackEntries(manifest) {
    return [...manifest.modules].sort((left, right) => {
        const orderDifference = left.order - right.order
        return orderDifference || left.id.localeCompare(right.id)
    })
}

function createLoaderEntry(pack) {
    const version = String(pack.loader.version)
    return {
        id: `net.neoforged:neoforge:${version}:installer@jar`,
        name: `NeoForge ${version} (installer)`,
        version,
        type: 'NeoForge',
        role: 'required',
        required: true,
        defaultEnabled: true,
        side: 'both',
        order: Number.MIN_SAFE_INTEGER,
        minecraftVersion: pack.minecraftVersion,
        loader: 'neoforge',
        expectedSha256: pack.loader.expectedSha256,
        expectedSize: pack.loader.expectedSize,
        source: pack.loader.source,
        artifactPath: `net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`
    }
}

function makeDistributionModule(entry, resolved, artifact) {
    const module = {
        id: entry.id,
        name: entry.name,
        type: entry.type,
        artifact: {
            size: artifact.size,
            MD5: artifact.md5,
            url: resolved.url,
            ...(entry.artifactPath ? { path: entry.artifactPath } : {})
        }
    }
    if (!entry.required) {
        module.required = {
            value: false,
            def: entry.defaultEnabled
        }
    }
    if (entry.access) {
        module.access = entry.access
    }
    return module
}

function makeLockArtifact(entry, resolved, artifact) {
    return {
        id: entry.id,
        name: entry.name,
        version: entry.version,
        type: entry.type,
        role: entry.role,
        side: entry.side,
        required: entry.required,
        defaultEnabled: entry.required ? true : entry.defaultEnabled,
        source: {
            type: resolved.type,
            url: resolved.url,
            ...(resolved.coordinate ? { coordinate: resolved.coordinate } : {})
        },
        integrity: {
            size: artifact.size,
            md5: artifact.md5,
            sha256: artifact.sha256
        },
        ...(entry.provenance ? { provenance: entry.provenance } : {})
    }
}

async function buildPack(manifest, args = {}, dependencies = {}) {
    validatePackManifest(manifest)
    const entries = [createLoaderEntry(manifest.pack), ...orderedPackEntries(manifest)]
    const concurrency = Number(args.concurrency || DEFAULT_CONCURRENCY)
    const cacheDir = path.resolve(args.cache || DEFAULT_CACHE_DIR)
    const artifactProvider = dependencies.artifactProvider || downloadArtifact

    const resolvedEntries = await mapLimit(entries, concurrency, async (entry) => {
        const resolved = await resolveSource(entry.source, args)
        const artifact = await artifactProvider(resolved.url, {
            cacheDir,
            expectedSha256: entry.expectedSha256,
            expectedSize: entry.expectedSize,
            label: entry.name,
            retries: Number(args.retries ?? DEFAULT_RETRIES),
            timeoutMs: Number(args.timeout || DEFAULT_TIMEOUT_MS),
            onRetry: (err, attempt) => {
                if (!asBoolean(args.quiet)) {
                    console.warn(`Retry ${attempt} for ${entry.name}: ${err.message}`)
                }
            }
        })
        assertIntegrity(artifact, entry.expectedSha256, entry.expectedSize, entry.name)
        if (!/^[a-f0-9]{32}$/i.test(artifact.md5 || '')) {
            throw new Error(`Artifact provider returned an invalid MD5 for ${entry.name}`)
        }
        return {
            module: makeDistributionModule(entry, resolved, artifact),
            lockArtifact: makeLockArtifact(entry, resolved, artifact)
        }
    })

    const server = {
        id: manifest.pack.id,
        name: manifest.pack.name,
        description: manifest.pack.description,
        icon: manifest.pack.icon,
        version: manifest.pack.version,
        address: manifest.pack.address,
        minecraftVersion: manifest.pack.minecraftVersion,
        mainServer: manifest.pack.mainServer,
        autoconnect: manifest.pack.autoconnect,
        javaOptions: manifest.pack.javaOptions,
        modules: resolvedEntries.map((entry) => entry.module)
    }
    const lock = {
        schemaVersion: PACK_SCHEMA_VERSION,
        pack: {
            id: manifest.pack.id,
            name: manifest.pack.name,
            version: manifest.pack.version,
            minecraftVersion: manifest.pack.minecraftVersion,
            loader: {
                type: manifest.pack.loader.type,
                version: manifest.pack.loader.version
            },
            ...(manifest.pack.futureModuleId ? { futureModuleId: manifest.pack.futureModuleId } : {})
        },
        artifacts: resolvedEntries.map((entry) => entry.lockArtifact)
    }
    return {
        server,
        modules: server.modules,
        lock
    }
}

function patchDistributionData(distribution, server) {
    if (!isObject(distribution)) {
        throw new Error('Distribution must be a JSON object')
    }
    if (!Array.isArray(distribution.servers)) {
        throw new Error('Distribution must contain a servers array')
    }
    const next = JSON.parse(JSON.stringify(distribution))
    const indexes = []
    for (let i = 0; i < next.servers.length; i++) {
        if (next.servers[i].id === server.id) {
            indexes.push(i)
        }
    }
    if (indexes.length > 1) {
        throw new Error(`Distribution contains duplicate server id: ${server.id}`)
    }
    if (indexes.length === 1) {
        next.servers[indexes[0]] = server
    } else {
        next.servers.push(server)
    }
    return next
}

function jsonText(value) {
    return `${JSON.stringify(value, null, 4)}\n`
}

function writeJsonAtomic(targetPath, value) {
    const resolved = path.resolve(targetPath)
    const directory = path.dirname(resolved)
    fs.mkdirSync(directory, { recursive: true })
    const tempPath = path.join(directory, `.${path.basename(resolved)}.${process.pid}.${crypto.randomUUID()}.tmp`)
    try {
        fs.writeFileSync(tempPath, jsonText(value), 'utf8')
        fs.renameSync(tempPath, resolved)
    } catch (err) {
        if (fs.existsSync(tempPath)) {
            fs.rmSync(tempPath, { force: true })
        }
        throw err
    }
}

function readJson(filePath, label) {
    const resolved = path.resolve(filePath)
    let raw
    try {
        raw = fs.readFileSync(resolved, 'utf8')
    } catch (err) {
        throw new Error(`Unable to read ${label} at ${resolved}: ${err.message}`)
    }
    try {
        return JSON.parse(raw)
    } catch (err) {
        throw new Error(`Invalid JSON in ${label} at ${resolved}: ${err.message}`)
    }
}

function requireCurrentJson(targetPath, expected, label) {
    const resolved = path.resolve(targetPath)
    if (!fs.existsSync(resolved)) {
        throw new Error(`${label} is missing: ${resolved}`)
    }
    const actual = readJson(resolved, label)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${label} is out of date: ${resolved}`)
    }
}

async function runPack(args, dependencies = {}) {
    const manifestPath = path.resolve(requireString(args.pack, '--pack'))
    const manifest = readJson(manifestPath, 'pack manifest')
    const generated = await buildPack(manifest, args, dependencies)
    const check = asBoolean(args.check)

    let nextDistribution
    if (args.distro) {
        const distribution = readJson(args.distro, 'distribution')
        nextDistribution = patchDistributionData(distribution, generated.server)
        if (check) {
            const currentServer = distribution.servers.find((server) => server.id === generated.server.id)
            if (!currentServer || JSON.stringify(currentServer) !== JSON.stringify(generated.server)) {
                throw new Error(`Distribution profile ${generated.server.id} is out of date`)
            }
        }
    }

    if (check) {
        if (args.lock) {
            requireCurrentJson(args.lock, generated.lock, 'Pack lock')
        }
        if (args.out) {
            requireCurrentJson(args.out, generated.modules, 'Modules output')
        }
        console.log(`Validated ${generated.server.id} (${generated.modules.length} artifacts)`)
        return generated
    }

    if (args.lock) {
        writeJsonAtomic(args.lock, generated.lock)
        console.log(`Wrote ${path.resolve(args.lock)}`)
    }
    if (args.out) {
        writeJsonAtomic(args.out, generated.modules)
        console.log(`Wrote ${path.resolve(args.out)}`)
    }
    if (args.distro) {
        writeJsonAtomic(args.distro, nextDistribution)
        console.log(`Updated ${path.resolve(args.distro)} (${generated.modules.length} artifacts)`)
    }
    if (!args.lock && !args.out && !args.distro) {
        console.log(jsonText(generated.modules).trimEnd())
    }
    return generated
}

function legacySource(mod) {
    if (mod.url) {
        if (!mod.id) {
            throw new Error(`Legacy mod with a direct URL must define id: ${JSON.stringify(mod)}`)
        }
        return {
            type: 'direct',
            url: mod.url
        }
    }
    return {
        type: mod.source || 'cursemaven',
        group: mod.group,
        artifact: mod.artifact,
        version: mod.version,
        classifier: mod.classifier,
        extension: mod.extension,
        base: mod.base,
        projectId: mod.projectId,
        fileId: mod.fileId,
        versionId: mod.versionId,
        fileIndex: mod.fileIndex,
        api: mod.modrinthApi
    }
}

async function buildLegacyModules(mods, args) {
    return mapLimit(mods, Number(args.concurrency || DEFAULT_CONCURRENCY), async (mod) => {
        const resolved = await resolveSource(legacySource(mod), args)
        let id = mod.id || resolved.coordinate
        if (!id) {
            throw new Error(`Unable to derive an id for legacy mod: ${JSON.stringify(mod)}`)
        }
        const artifact = await downloadArtifact(resolved.url, {
            cacheDir: args.cache,
            expectedSha256: mod.expectedSha256,
            expectedSize: mod.expectedSize,
            label: mod.name || id,
            retries: Number(args.retries ?? DEFAULT_RETRIES),
            timeoutMs: Number(args.timeout || DEFAULT_TIMEOUT_MS)
        })
        const module = {
            id,
            name: mod.name || id,
            type: mod.type || 'ForgeMod',
            artifact: {
                size: artifact.size,
                MD5: artifact.md5,
                url: resolved.url
            }
        }
        if (mod.required === false) {
            module.required = {
                value: false,
                def: mod.defaultEnabled !== false
            }
        }
        if (mod.access) {
            module.access = mod.access
        }
        return module
    })
}

async function createLegacyServer(distribution, args) {
    if (String(args.loader || '').toLowerCase() !== 'neoforge') {
        throw new Error('Only loader=neoforge is supported when creating a legacy server')
    }
    const loaderVersion = requireString(args.loaderVersion, '--loaderVersion')
    const minecraftVersion = requireString(args.minecraftVersion, '--minecraftVersion')
    const loaderUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`
    const artifact = await downloadArtifact(loaderUrl, {
        cacheDir: args.cache,
        expectedSha256: args.loaderSha256,
        expectedSize: args.loaderSize ? Number(args.loaderSize) : undefined,
        label: `NeoForge ${loaderVersion}`,
        retries: Number(args.retries ?? DEFAULT_RETRIES),
        timeoutMs: Number(args.timeout || DEFAULT_TIMEOUT_MS)
    })
    return {
        id: requireString(args.server, '--server'),
        name: args.serverName || args.server,
        description: args.description || '',
        icon: args.icon || distribution.servers[0]?.icon || '',
        version: args.serverVersion || '0.0.1',
        address: args.address || 'localhost:25565',
        minecraftVersion,
        mainServer: false,
        autoconnect: false,
        modules: [{
            id: `net.neoforged:neoforge:${loaderVersion}:installer@jar`,
            name: `NeoForge ${loaderVersion} (installer)`,
            type: 'NeoForge',
            artifact: {
                size: artifact.size,
                MD5: artifact.md5,
                url: loaderUrl,
                path: `net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`
            }
        }]
    }
}

async function runLegacy(args) {
    const raw = readJson(requireString(args.mods, '--mods'), 'legacy mods list')
    const mods = Array.isArray(raw) ? raw : raw.mods
    if (!Array.isArray(mods)) {
        throw new Error('Legacy mods file must be an array or contain a mods array')
    }
    const modules = await buildLegacyModules(mods, args)

    if (args.distro) {
        const distribution = readJson(args.distro, 'distribution')
        const serverId = requireString(args.server, '--server')
        let server = distribution.servers.find((candidate) => candidate.id === serverId)
        if (!server && asBoolean(args.createServer)) {
            server = await createLegacyServer(distribution, args)
            distribution.servers.push(server)
        } else if (server && asBoolean(args.createServer) && asBoolean(args.overwriteServer)) {
            server = await createLegacyServer(distribution, args)
            distribution.servers[distribution.servers.findIndex((candidate) => candidate.id === serverId)] = server
        } else if (!server) {
            throw new Error(`Server not found: ${serverId}`)
        }
        const incomingIds = new Set(modules.map((module) => module.id))
        server.modules = (server.modules || []).filter((module) => !incomingIds.has(module.id))
        server.modules.push(...modules)
        writeJsonAtomic(args.distro, distribution)
        console.log(`Patched ${path.resolve(args.distro)} (${modules.length} modules)`)
    } else if (args.out) {
        writeJsonAtomic(args.out, modules)
        console.log(`Wrote ${path.resolve(args.out)}`)
    } else {
        console.log(jsonText(modules).trimEnd())
    }
    return modules
}

async function main(argv, dependencies = {}) {
    const args = parseArgs(argv)
    if (args.help || args.h) {
        usage()
        return null
    }
    if (args.pack) {
        return runPack(args, dependencies)
    }
    if (args.mods) {
        return runLegacy(args)
    }
    usage()
    throw new Error('Either --pack or --mods is required')
}

module.exports = {
    PACK_SCHEMA_VERSION,
    assertIntegrity,
    buildMavenId,
    buildMavenUrl,
    buildPack,
    downloadArtifact,
    main,
    mapLimit,
    orderedPackEntries,
    parseArgs,
    patchDistributionData,
    resolveSource,
    runPack,
    usage,
    validatePackManifest,
    writeJsonAtomic
}
