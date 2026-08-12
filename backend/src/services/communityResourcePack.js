'use strict'

const fs = require('fs')
const crypto = require('crypto')
const yauzl = require('yauzl')
const { CommunityValidationError, FORMAT_CONTRACTS, TYPES } = require('@allegator-games/community-core')

const MAX_COMPRESSED_BYTES = 100 * 1024 * 1024
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024
const MAX_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_ENTRIES = 10_000
const MAX_COMPRESSION_RATIO = 100
const SUPPORTED_PACK_FORMAT = 34
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
        if(!['minecraft', 'cobblepower', 'cobblemon'].includes(namespace)) {
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

async function validateResourcePack(filePath) {
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
    return {
        sizeBytes: stat.size,
        sha256,
        format: FORMAT_CONTRACTS[TYPES.RESOURCE_PACKS],
        typeData: {
            packFormat: state.packMetadata.packFormat,
            description: state.packMetadata.description,
            entryCount: state.entries,
            expandedBytes: state.expandedBytes,
            namespaces: Array.from(state.namespaces).sort()
        },
        dependencies: [],
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
    SUPPORTED_PACK_FORMAT,
    normalizeEntryPath,
    parsePackMetadata,
    validatePngHeader,
    validateResourcePack
}
