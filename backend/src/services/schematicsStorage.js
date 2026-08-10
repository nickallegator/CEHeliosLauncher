const fs = require('fs/promises')
const path = require('path')
const config = require('../config')

const baseDir = config.schematics.storageDir
    ? path.resolve(config.schematics.storageDir)
    : path.resolve(process.cwd(), 'storage', 'schematics')

async function ensureStorageDir() {
    await fs.mkdir(baseDir, { recursive: true })
    return baseDir
}

const SCHEMATIC_FORMAT_EXTENSIONS = {
    json: 'json'
}

function normalizeFormat(format){
    const normalized = typeof format === 'string' ? format.trim().toLowerCase() : ''
    return SCHEMATIC_FORMAT_EXTENSIONS[normalized] ? normalized : 'json'
}

function resolveSchematicExtension(format){
    const normalized = normalizeFormat(format)
    return SCHEMATIC_FORMAT_EXTENSIONS[normalized] || 'json'
}

function buildObjectKey(id, format) {
    const ext = resolveSchematicExtension(format)
    return `${id}.${ext}`
}

function buildHashObjectKey(hash, format){
    const safeHash = String(hash || '').trim().toLowerCase()
    const ext = resolveSchematicExtension(format)
    return `hash/${safeHash}.${ext}`
}

function buildThumbnailKey(id, label, mime){
    const safeLabel = String(label || 'thumb').replace(/[^a-z0-9_-]/gi, '_')
    let ext = 'png'
    if(mime === 'image/webp'){
        ext = 'webp'
    } else if(mime === 'image/jpeg'){
        ext = 'jpg'
    }
    return `${id}-${safeLabel}.${ext}`
}

async function writeSchematic(objectKey, schematic) {
    const dir = await ensureStorageDir()
    const fullPath = path.join(dir, objectKey)
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    await fs.writeFile(fullPath, JSON.stringify(schematic, null, 2), 'utf8')
    return fullPath
}

async function writeThumbnail(objectKey, buffer){
    const dir = await ensureStorageDir()
    const fullPath = path.join(dir, objectKey)
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    await fs.writeFile(fullPath, buffer)
    return fullPath
}

async function readThumbnail(objectKey) {
    const dir = await ensureStorageDir()
    const fullPath = path.join(dir, objectKey)
    return fs.readFile(fullPath)
}

async function objectExists(objectKey){
    const dir = await ensureStorageDir()
    const fullPath = path.join(dir, objectKey)
    try {
        await fs.access(fullPath)
        return true
    } catch (err) {
        if(err.code === 'ENOENT'){
            return false
        }
        throw err
    }
}

async function readSchematic(objectKey) {
    const dir = await ensureStorageDir()
    const fullPath = path.join(dir, objectKey)
    try {
        const raw = await fs.readFile(fullPath, 'utf8')
        return JSON.parse(raw)
    } catch (err) {
        if(err.code === 'ENOENT'){
            return null
        }
        throw err
    }
}

module.exports = {
    ensureStorageDir,
    normalizeFormat,
    resolveSchematicExtension,
    buildObjectKey,
    buildHashObjectKey,
    buildThumbnailKey,
    writeSchematic,
    writeThumbnail,
    readThumbnail,
    objectExists,
    readSchematic
}
