'use strict'

const fs = require('fs')
const crypto = require('crypto')
const yauzl = require('yauzl')
const AdmZip = require('adm-zip')
const { CommunityValidationError, FORMAT_CONTRACTS, TYPES } = require('@allegator-games/community-core')
const {
    indexResourcePackStreaming,
    normalizePokemonAspects,
    showcaseCandidatesFromComponents
} = require('@allegator-games/resource-pack-studio')

const MAX_COMPRESSED_BYTES = 100 * 1024 * 1024
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024
const MAX_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_ENTRIES = 10_000
const MAX_COMPRESSION_RATIO = 100
const SUPPORTED_PACK_FORMAT = 34
const MAX_SHOWCASE_SUBJECTS = 8
const MAX_SHOWCASE_POKEMON = 4
const MAX_RENDER_OVERLAY_BYTES = 16 * 1024 * 1024
const MAX_RENDER_OVERLAY_EXPANDED_BYTES = 64 * 1024 * 1024
const RESOURCE_LOCATION = /^[a-z0-9_.-]+:[a-z0-9/._-]+$/
const COBBLEMON_EXTENSION_RESOURCE = /^(?:bedrock\/pokemon\/(?:animations|models|posers|resolvers)\/|textures\/pokemon\/)/i
const FORBIDDEN_EXTENSIONS = new Set([
    '.7z', '.apk', '.app', '.bat', '.bin', '.cmd', '.com', '.dll', '.dmg', '.exe', '.gz',
    '.jar', '.js', '.lnk', '.msi', '.ps1', '.rar', '.reg', '.scr', '.sh', '.so', '.tar',
    '.vbs', '.war', '.xz', '.zip'
])
const ALLOWED_EXTENSIONS = new Set([
    '', '.json', '.mcmeta', '.png', '.ogg', '.ttf', '.otf', '.txt', '.md', '.license',
    '.lang', '.properties'
])

function validationError(code, message, details = null) {
    return new CommunityValidationError(code, message, details)
}

function openZip(filePath) {
    return new Promise((resolve, reject) => {
        yauzl.open(filePath, { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true }, (error, zip) => {
            if(error) reject(validationError('invalid_resource_pack_zip', 'Resource Pack is not a valid ZIP archive.'))
            else resolve(zip)
        })
    })
}

function readEntry(zip, entry, maxBytes) {
    return new Promise((resolve, reject) => {
        zip.openReadStream(entry, (error, stream) => {
            if(error) {
                reject(validationError('invalid_resource_pack_entry', `Unable to read ${entry.fileName}.`))
                return
            }
            const chunks = []
            let total = 0
            stream.on('data', chunk => {
                total += chunk.length
                if(total > maxBytes) stream.destroy(validationError('resource_pack_entry_limit', `${entry.fileName} exceeds its size limit.`))
                else chunks.push(chunk)
            })
            stream.on('error', reject)
            stream.on('end', () => resolve(Buffer.concat(chunks, total)))
        })
    })
}

function readEntryPrefix(zip, entry, prefixBytes) {
    return new Promise((resolve, reject) => {
        zip.openReadStream(entry, (error, stream) => {
            if(error) {
                reject(validationError('invalid_resource_pack_entry', `Unable to read ${entry.fileName}.`))
                return
            }
            const chunks = []
            let retained = 0
            stream.on('data', chunk => {
                if(retained >= prefixBytes) return
                const slice = chunk.subarray(0, prefixBytes - retained)
                chunks.push(slice)
                retained += slice.length
            })
            stream.on('error', reject)
            stream.on('end', () => resolve(Buffer.concat(chunks, retained)))
        })
    })
}

function validatePngHeader(buffer, name) {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    if(buffer.length < 24 || !buffer.subarray(0, 8).equals(signature) || buffer.toString('ascii', 12, 16) !== 'IHDR') {
        throw validationError('invalid_resource_pack_png', `${name} is not a valid PNG resource.`)
    }
    const width = buffer.readUInt32BE(16)
    const height = buffer.readUInt32BE(20)
    if(width < 1 || height < 1 || width > 16_384 || height > 16_384 || width * height > 67_108_864) {
        throw validationError('resource_pack_png_dimensions', `${name} has unsafe image dimensions.`)
    }
}

function validateBinaryHeader(buffer, expected, code, message) {
    if(buffer.length < expected.length || !buffer.subarray(0, expected.length).equals(expected)) {
        throw validationError(code, message)
    }
}

async function validateEntryPayload(zip, entry, info) {
    const extension = extensionFor(info.name)
    if(extension === '.json' || extension === '.mcmeta') {
        const payload = await readEntry(zip, entry, MAX_ENTRY_BYTES)
        try {
            JSON.parse(payload.toString('utf8'))
        } catch(_error) {
            throw validationError('invalid_resource_pack_json', `${info.name} is not valid JSON.`)
        }
        return payload
    }
    if(extension === '.png') {
        const prefix = await readEntryPrefix(zip, entry, 24)
        validatePngHeader(prefix, info.name)
        return null
    }
    if(extension === '.ogg') {
        const prefix = await readEntryPrefix(zip, entry, 4)
        validateBinaryHeader(prefix, Buffer.from('OggS'), 'invalid_resource_pack_ogg', `${info.name} is not a valid OGG resource.`)
        return null
    }
    if(extension === '.ttf' || extension === '.otf') {
        const prefix = await readEntryPrefix(zip, entry, 4)
        const valid = prefix.equals(Buffer.from([0x00, 0x01, 0x00, 0x00])) || prefix.toString('ascii') === 'OTTO'
        if(!valid) throw validationError('invalid_resource_pack_font', `${info.name} is not a valid font resource.`)
    }
    return null
}

function normalizeEntryPath(fileName) {
    const raw = String(fileName || '')
    if(!raw || raw.includes('\\') || raw.includes('\0') || raw.startsWith('/') || /^[a-z]:/i.test(raw)) {
        throw validationError('unsafe_resource_pack_path', `Resource Pack contains an unsafe path: ${raw || '<empty>'}.`)
    }
    const parts = raw.split('/')
    if(parts.some(part => part === '..' || part === '.')) {
        throw validationError('unsafe_resource_pack_path', `Resource Pack contains path traversal: ${raw}.`)
    }
    const normalized = parts.filter(Boolean).join('/')
    if(!normalized) throw validationError('unsafe_resource_pack_path', 'Resource Pack contains an empty path.')
    return normalized
}

function extensionFor(fileName) {
    const basename = fileName.split('/').at(-1).toLowerCase()
    const index = basename.lastIndexOf('.')
    return index < 0 ? '' : basename.slice(index)
}

function validateEntryMetadata(entry, state) {
    const name = normalizeEntryPath(entry.fileName)
    const normalizedKey = name.toLowerCase()
    if(state.paths.has(normalizedKey)) throw validationError('duplicate_resource_pack_path', `Resource Pack contains a duplicate path: ${name}.`)
    state.paths.add(normalizedKey)
    const directory = entry.fileName.endsWith('/')
    const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
    const fileType = unixMode & 0o170000
    if(fileType === 0o120000) throw validationError('resource_pack_link_rejected', `Resource Pack links are not permitted: ${name}.`)
    if((entry.generalPurposeBitFlag & 0x1) !== 0) throw validationError('encrypted_resource_pack_entry', `Encrypted Resource Pack entries are not permitted: ${name}.`)
    if(directory) return { name, directory: true }

    const extension = extensionFor(name)
    if(FORBIDDEN_EXTENSIONS.has(extension)) throw validationError('forbidden_resource_pack_file', `Resource Pack contains forbidden file type ${extension}: ${name}.`)
    if(!ALLOWED_EXTENSIONS.has(extension)) throw validationError('unsupported_resource_pack_file', `Resource Pack file type ${extension || '<none>'} is not supported: ${name}.`)
    if(entry.uncompressedSize > MAX_ENTRY_BYTES) throw validationError('resource_pack_entry_limit', `${name} exceeds the 64 MiB entry limit.`)
    const compressed = Number(entry.compressedSize)
    const expanded = Number(entry.uncompressedSize)
    if(expanded > 0 && compressed === 0) throw validationError('resource_pack_compression_ratio', `${name} has an unsafe compression ratio.`)
    if(compressed > 0 && expanded / compressed > MAX_COMPRESSION_RATIO) {
        throw validationError('resource_pack_compression_ratio', `${name} exceeds the ${MAX_COMPRESSION_RATIO}:1 compression ratio limit.`)
    }
    state.expandedBytes += expanded
    if(state.expandedBytes > MAX_EXPANDED_BYTES) throw validationError('resource_pack_expanded_limit', 'Resource Pack exceeds the 512 MiB expanded size limit.')
    const namespaceMatch = name.match(/^assets\/([^/]+)\//i)
    if(namespaceMatch) {
        const namespace = namespaceMatch[1].toLowerCase()
        const relativePath = name.slice(namespaceMatch[0].length)
        if(!['minecraft', 'cobblepower', 'cobblemon'].includes(namespace) && !COBBLEMON_EXTENSION_RESOURCE.test(relativePath)) {
            throw validationError('unapproved_resource_pack_namespace', `Resource Pack namespace ${namespace} is not approved for Cobble Power Community packs.`)
        }
        if(namespace !== 'minecraft') state.namespaces.add(namespace)
    }
    return { name, directory: false }
}

function parsePackMetadata(buffer) {
    let root
    try {
        root = JSON.parse(buffer.toString('utf8'))
    } catch(_error) {
        throw validationError('invalid_pack_metadata', 'pack.mcmeta is not valid JSON.')
    }
    const pack = root?.pack
    if(!pack || typeof pack !== 'object') throw validationError('invalid_pack_metadata', 'pack.mcmeta must contain a pack object.')
    const direct = Number(pack.pack_format)
    const range = pack.supported_formats
    const min = Array.isArray(range) ? Number(range[0]) : Number(range?.min_inclusive)
    const max = Array.isArray(range) ? Number(range[1]) : Number(range?.max_inclusive)
    const supported = direct === SUPPORTED_PACK_FORMAT
        || (Number.isInteger(min) && Number.isInteger(max) && min <= SUPPORTED_PACK_FORMAT && max >= SUPPORTED_PACK_FORMAT)
    if(!supported) {
        throw validationError('incompatible_pack_format', `Resource Pack must support Minecraft 1.21.1 pack format ${SUPPORTED_PACK_FORMAT}.`, {
            expected: SUPPORTED_PACK_FORMAT,
            actual: Number.isFinite(direct) ? direct : null
        })
    }
    return {
        packFormat: direct,
        description: typeof pack.description === 'string' ? pack.description.slice(0, 300) : null
    }
}

function normalizeShowcase(raw, candidates) {
    if(raw == null) return null
    if(Number(raw.schemaVersion) !== 1 || !Array.isArray(raw.subjects)) {
        throw validationError('invalid_resource_pack_showcase', 'Resource Pack showcase must use schema version 1 and contain a subjects array.')
    }
    if(raw.subjects.length > MAX_SHOWCASE_SUBJECTS) {
        throw validationError('resource_pack_showcase_limit', `Select at most ${MAX_SHOWCASE_SUBJECTS} showcase subjects.`)
    }
    const candidateKey = subject => subject.kind === 'block'
        ? `block:${subject.id}`
        : `pokemon:${subject.species}:${normalizePokemonAspects(subject.aspects?.length ? subject.aspects : [subject.form]).filter(value => value !== 'shiny').join('+') || 'default'}`
    const candidateMap = new Map(candidates.map(candidate => [candidateKey(candidate), candidate]))
    let pokemonCount = 0
    const seen = new Set()
    const subjects = raw.subjects.map((subject, index) => {
        const kind = String(subject?.kind || '').toLowerCase()
        if(kind === 'block') {
            const id = String(subject.id || '').toLowerCase()
            if(!RESOURCE_LOCATION.test(id)) throw validationError('invalid_showcase_subject', `Showcase block ${index + 1} has an invalid identifier.`)
            const key = `block:${id}`
            const candidate = candidateMap.get(key)
            if(!candidate) throw validationError('unmodified_showcase_subject', `Showcase block ${id} is not changed by this Resource Pack.`)
            if(seen.has(key)) throw validationError('duplicate_showcase_subject', `Showcase subject ${id} is selected more than once.`)
            seen.add(key)
            return { kind, id, state: subject.state && typeof subject.state === 'object' && !Array.isArray(subject.state) ? subject.state : {}, sourcePath: candidate.sourcePath }
        }
        if(kind === 'pokemon') {
            pokemonCount += 1
            if(pokemonCount > MAX_SHOWCASE_POKEMON) throw validationError('resource_pack_showcase_pokemon_limit', `Select at most ${MAX_SHOWCASE_POKEMON} Pokémon showcase subjects.`)
            const species = String(subject.species || '').toLowerCase()
            if(!RESOURCE_LOCATION.test(species)) throw validationError('invalid_showcase_subject', `Showcase Pokémon ${index + 1} has an invalid species.`)
            const rawAspects = normalizePokemonAspects(subject.aspects?.length ? subject.aspects : [subject.form])
            const shiny = subject.shiny === true || rawAspects.includes('shiny')
            const requestedAspects = rawAspects.filter(value => value !== 'shiny')
            const key = `pokemon:${species}:${requestedAspects.join('+') || 'default'}`
            const speciesCandidates = candidates.filter(value => value.kind === 'pokemon' && value.species === species)
            const candidate = candidateMap.get(key)
                || speciesCandidates.find(value => value.aspects?.length === 0)
                || speciesCandidates[0]
            if(shiny && candidate?.shinyVariant?.declared !== true) {
                throw validationError('unsupported_shiny_showcase', `The selected shiny appearance is not declared by ${species}.`)
            }
            if(!candidate) throw validationError('unmodified_showcase_subject', `Showcase Pokémon ${species} is not changed by this Resource Pack.`)
            const resolvedKey = candidateKey(candidate)
            if(seen.has(resolvedKey)) throw validationError('duplicate_showcase_subject', `Showcase subject ${species} is selected more than once.`)
            seen.add(resolvedKey)
            const gender = String(subject.gender || candidate.gender || 'MALE').toUpperCase()
            if(!['MALE', 'FEMALE', 'GENDERLESS'].includes(gender)) throw validationError('invalid_showcase_subject', 'Showcase Pokémon gender is invalid.')
            return {
                kind, species, form: String(candidate.form || subject.form || '').slice(0, 80).toLowerCase(), gender,
                aspects: candidate.aspects || requestedAspects,
                shiny,
                shinyVariant: candidate.shinyVariant,
                defaultShiny: candidate.defaultShiny === true,
                resourceNamespace: candidate.resourceNamespace || 'cobblemon',
                resourceNamespaces: candidate.resourceNamespaces || [candidate.resourceNamespace || 'cobblemon'],
                pokemonOverride: candidate.pokemonOverride,
                sourcePath: candidate.sourcePath,
                sourcePaths: candidate.sourcePaths || [candidate.sourcePath]
            }
        }
        throw validationError('invalid_showcase_subject', `Showcase subject ${index + 1} has an unsupported kind.`)
    })
    return { schemaVersion: 1, subjects }
}

function resourceReferences(document) {
    const references = new Set()
    const visit = value => {
        if(Array.isArray(value)) return value.forEach(visit)
        if(value && typeof value === 'object') return Object.values(value).forEach(visit)
        if(typeof value !== 'string') return
        const match = value.toLowerCase().match(/^([a-z0-9_.-]+):([a-z0-9/._-]+)$/)
        if(match) references.add(`${match[1]}:${match[2]}`)
    }
    visit(document)
    return references
}

function resolveReferencePaths(reference, entryNames) {
    const [namespace, resourcePath] = reference.split(':', 2)
    const withoutJson = resourcePath.replace(/\.json$/i, '')
    const withoutPng = resourcePath.replace(/\.png$/i, '')
    const withoutGeometryExtension = withoutJson.replace(/\.geo$/i, '')
    const candidates = new Set([
        `assets/${namespace}/${resourcePath}`,
        `assets/${namespace}/${withoutJson}.json`,
        `assets/${namespace}/${withoutPng}.png`,
        `assets/${namespace}/models/${withoutJson}.json`,
        `assets/${namespace}/textures/${withoutPng}.png`,
        `assets/${namespace}/bedrock/${withoutJson}.json`,
        `assets/${namespace}/bedrock/${withoutGeometryExtension}.geo.json`
    ])
    const resolved = [...candidates].filter(value => entryNames.has(value.toLowerCase()))
    const basename = withoutGeometryExtension.split('/').at(-1)
    const bedrockPrefix = `assets/${namespace}/bedrock/pokemon/`
    const suffixes = [`/${basename}.geo.json`, `/${basename}.json`]
    const names = typeof entryNames.keys === 'function' ? entryNames.keys() : entryNames
    for(const entryName of names) {
        if(entryName.startsWith(bedrockPrefix) && suffixes.some(suffix => entryName.endsWith(suffix))) resolved.push(entryName)
    }
    return [...new Set(resolved)].sort()
}

function buildRenderOverlay(filePath, showcase) {
    if(!showcase?.subjects?.length) return null
    const source = new AdmZip(filePath)
    const entries = source.getEntries().filter(entry => !entry.isDirectory)
    const byName = new Map(entries.map(entry => [normalizeEntryPath(entry.entryName).toLowerCase(), entry]))
    const selected = new Set(['pack.mcmeta'])
    if(byName.has('pack.png')) selected.add('pack.png')
    for(const entry of entries) {
        const lower = entry.entryName.toLowerCase()
        if(lower === 'license.txt' || lower.endsWith('/license.txt') || lower.endsWith('/license.md')) selected.add(lower)
    }
    for(const subject of showcase.subjects) {
        for(const sourcePath of subject.sourcePaths || [subject.sourcePath]) selected.add(String(sourcePath).toLowerCase())
    }
    const pending = [...selected]
    while(pending.length > 0) {
        const name = pending.shift()
        const entry = byName.get(name)
        if(!entry || !name.endsWith('.json')) continue
        let document
        try { document = JSON.parse(entry.getData().toString('utf8')) } catch(_error) { continue }
        for(const reference of resourceReferences(document)) {
            for(const resolved of resolveReferencePaths(reference, byName)) {
                if(!selected.has(resolved)) { selected.add(resolved); pending.push(resolved) }
            }
        }
    }
    const output = new AdmZip()
    let expandedBytes = 0
    for(const name of [...selected].sort()) {
        const entry = byName.get(name)
        if(!entry) continue
        const bytes = entry.getData()
        expandedBytes += bytes.length
        if(expandedBytes > MAX_RENDER_OVERLAY_EXPANDED_BYTES) throw validationError('render_overlay_expanded_limit', 'Resource Pack render overlay exceeds 64 MiB expanded.')
        output.addFile(name, bytes)
    }
    const descriptor = { schemaVersion: 1, subjects: showcase.subjects.map(({ sourcePath: _sourcePath, sourcePaths: _sourcePaths, ...subject }) => subject) }
    output.addFile('ag-community-showcase.json', Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`, 'utf8'))
    const bytes = output.toBuffer()
    if(bytes.length > MAX_RENDER_OVERLAY_BYTES) throw validationError('render_overlay_size_limit', 'Resource Pack render overlay exceeds 16 MiB compressed.')
    return {
        role: 'render-overlay', bytes, mimeType: 'application/zip',
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        metadata: descriptor
    }
}

async function validateResourcePack(filePath, options = {}) {
    const stat = await fs.promises.stat(filePath)
    if(!stat.isFile() || stat.size < 1 || stat.size > MAX_COMPRESSED_BYTES) {
        throw validationError('resource_pack_size_limit', 'Resource Pack ZIP must be between 1 byte and 100 MiB.')
    }
    const zip = await openZip(filePath)
    const state = { entries: 0, expandedBytes: 0, namespaces: new Set(), paths: new Set(), packMetadata: null, packPng: null }
    try {
        await new Promise((resolve, reject) => {
            zip.on('error', error => reject(validationError('invalid_resource_pack_zip', error.message)))
            zip.on('end', resolve)
            zip.on('entry', async entry => {
                try {
                    state.entries += 1
                    if(state.entries > MAX_ENTRIES) throw validationError('resource_pack_entry_count', 'Resource Pack exceeds the 10,000 entry limit.')
                    const info = validateEntryMetadata(entry, state)
                    if(!info.directory && info.name.toLowerCase() === 'pack.mcmeta') {
                        const payload = await validateEntryPayload(zip, entry, info)
                        if(payload.length > 256 * 1024) throw validationError('invalid_pack_metadata', 'pack.mcmeta exceeds 256 KiB.')
                        state.packMetadata = parsePackMetadata(payload)
                    } else if(!info.directory && info.name.toLowerCase() === 'pack.png') {
                        state.packPng = await readEntry(zip, entry, 5 * 1024 * 1024)
                        validatePngHeader(state.packPng, info.name)
                    } else if(!info.directory) {
                        await validateEntryPayload(zip, entry, info)
                    }
                    zip.readEntry()
                } catch(error) {
                    reject(error)
                }
            })
            zip.readEntry()
        })
    } finally {
        zip.close()
    }
    if(!state.packMetadata) throw validationError('missing_pack_metadata', 'Resource Pack must contain pack.mcmeta at the archive root.')
    if(state.namespaces.size === 0) throw validationError('missing_cobble_assets', 'Resource Pack must contain assets/cobblepower or assets/cobblemon content.')

    const sha256 = await new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256')
        const stream = fs.createReadStream(filePath)
        stream.on('data', chunk => hash.update(chunk))
        stream.on('error', reject)
        stream.on('end', () => resolve(hash.digest('hex')))
    })
    // Build showcase identities from the same resolver-first component index used by
    // Pack Studio. The streaming validation scan remains responsible for payload
    // safety, while the shared index prevents form poser names becoming fake species.
    const indexedPack = await indexResourcePackStreaming(filePath)
    const candidates = showcaseCandidatesFromComponents(indexedPack.components)
    const showcase = normalizeShowcase(options.showcase, candidates)
    const renderOverlay = buildRenderOverlay(filePath, showcase)
    const compositionIndex = options.indexComponents === false ? null : indexedPack
    return {
        sizeBytes: stat.size,
        sha256,
        format: FORMAT_CONTRACTS[TYPES.RESOURCE_PACKS],
        typeData: {
            packFormat: state.packMetadata.packFormat,
            description: state.packMetadata.description,
            entryCount: state.entries,
            expandedBytes: state.expandedBytes,
            namespaces: Array.from(state.namespaces).sort(),
            showcaseCandidates: candidates.map(({ sourcePath: _sourcePath, sourcePaths: _sourcePaths, ...candidate }) => candidate),
            showcase: showcase ? { schemaVersion: 1, subjects: showcase.subjects.map(({ sourcePath: _sourcePath, sourcePaths: _sourcePaths, ...subject }) => subject) } : null
        },
        dependencies: [],
        renderAssets: renderOverlay ? [renderOverlay] : [],
        compositionIndex,
        previewBuffer: state.packPng,
        filePath
    }
}

module.exports = {
    ALLOWED_EXTENSIONS,
    FORBIDDEN_EXTENSIONS,
    MAX_COMPRESSED_BYTES,
    MAX_COMPRESSION_RATIO,
    MAX_ENTRIES,
    MAX_ENTRY_BYTES,
    MAX_EXPANDED_BYTES,
    MAX_RENDER_OVERLAY_BYTES,
    MAX_RENDER_OVERLAY_EXPANDED_BYTES,
    MAX_SHOWCASE_POKEMON,
    MAX_SHOWCASE_SUBJECTS,
    SUPPORTED_PACK_FORMAT,
    normalizeEntryPath,
    normalizeShowcase,
    parsePackMetadata,
    validatePngHeader,
    validateResourcePack
}
