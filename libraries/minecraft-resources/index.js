/**
 * minecraft-resources
 * Shared resource resolver for Minecraft assets (blockstates, models, textures).
 * Launcher uses local jars; web can plug in a fetch-based provider later.
 */

'use strict'

const fs = require('fs/promises')
const path = require('path')
const AdmZip = require('adm-zip')

const SAFE_PROFILE_ID = /^[a-zA-Z0-9._+-]+$/
const SAFE_MAVEN_PART = /^[a-zA-Z0-9._+-]+$/

class JarResourceProvider {
    constructor(jarPath) {
        if(!jarPath){
            throw new Error('jarPath is required')
        }
        this.jarPath = jarPath
        this._zip = null
        this._entries = null
    }

    _ensureZip(){
        if(!this._zip){
            this._zip = new AdmZip(this.jarPath)
        }
        return this._zip
    }

    _ensureEntries(){
        if(!this._entries){
            this._entries = new Map()
            for(const entry of this._ensureZip().getEntries()){
                if(entry.isDirectory) continue
                const name = String(entry.entryName || '').replaceAll('\\', '/')
                if(name) this._entries.set(name.toLowerCase(), { name, entry })
            }
        }
        return this._entries
    }

    getBuffer(resourcePath){
        const normalized = String(resourcePath || '').replaceAll('\\', '/')
        const direct = this._ensureZip().getEntry(normalized)
        if(direct) return direct.getData()
        const record = this._ensureEntries().get(normalized.toLowerCase())
        if(!record){
            return null
        }
        return record.entry.getData()
    }

    getText(resourcePath){
        const buf = this.getBuffer(resourcePath)
        return buf ? buf.toString('utf8') : null
    }

    getJson(resourcePath){
        const text = this.getText(resourcePath)
        if(!text){
            return null
        }
        return JSON.parse(text)
    }

    list(prefix = ''){
        const normalized = String(prefix || '').replaceAll('\\', '/').toLowerCase()
        return [...this._ensureEntries().values()]
            .filter(record => record.name.toLowerCase().startsWith(normalized))
            .map(record => record.name)
            .sort((left, right) => left.localeCompare(right))
    }
}

class ZipBufferResourceProvider {
    constructor(buffer, options = {}) {
        const value = Buffer.from(buffer || [])
        const maxBytes = Number(options.maxBytes) || 16 * 1024 * 1024
        if(value.length < 1 || value.length > maxBytes) throw new Error('ZIP resource overlay exceeds its compressed size limit.')
        this._zip = new AdmZip(value)
        this._entries = new Map()
        const maxEntries = Number(options.maxEntries) || 2048
        const maxExpandedBytes = Number(options.maxExpandedBytes) || 64 * 1024 * 1024
        let expandedBytes = 0
        for(const entry of this._zip.getEntries()) {
            const name = String(entry.entryName || '').replaceAll('\\', '/')
            if(entry.isDirectory) continue
            if(!name || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').some(part => part === '..' || part === '.')) throw new Error('ZIP resource overlay contains an unsafe path.')
            expandedBytes += Number(entry.header?.size || 0)
            if(expandedBytes > maxExpandedBytes || this._entries.size >= maxEntries) throw new Error('ZIP resource overlay exceeds its expanded limits.')
            this._entries.set(name.toLowerCase(), entry)
        }
    }

    getBuffer(resourcePath) {
        const entry = this._entries.get(String(resourcePath || '').replaceAll('\\', '/').toLowerCase())
        return entry ? entry.getData() : null
    }

    getText(resourcePath) { const buffer = this.getBuffer(resourcePath); return buffer ? buffer.toString('utf8') : null }
    getJson(resourcePath) { const text = this.getText(resourcePath); return text ? JSON.parse(text) : null }
    list(prefix = '') {
        const normalized = String(prefix || '').replaceAll('\\', '/').toLowerCase()
        return [...this._entries.keys()].filter(name => name.startsWith(normalized)).sort()
    }
}

class DirectoryResourceProvider {
    constructor(rootDir) {
        if(!rootDir){
            throw new Error('rootDir is required')
        }
        this.rootDir = rootDir
    }

    _resolve(resourcePath){
        return path.join(this.rootDir, resourcePath)
    }

    async getBuffer(resourcePath){
        try {
            return await fs.readFile(this._resolve(resourcePath))
        } catch (err) {
            if(err.code === 'ENOENT'){
                return null
            }
            throw err
        }
    }

    async getText(resourcePath){
        const buf = await this.getBuffer(resourcePath)
        return buf ? buf.toString('utf8') : null
    }

    async getJson(resourcePath){
        const text = await this.getText(resourcePath)
        if(!text){
            return null
        }
        return JSON.parse(text)
    }

    async list(prefix = ''){
        const normalized = String(prefix || '').replaceAll('\\', '/').replace(/^\/+/, '')
        if(normalized.split('/').some(part => part === '..' || part === '.')) throw new Error('Resource prefix contains an unsafe path.')
        const root = path.resolve(this.rootDir)
        const start = path.resolve(root, normalized)
        const relativeStart = path.relative(root, start)
        if(relativeStart.startsWith('..') || path.isAbsolute(relativeStart)) throw new Error('Resource prefix leaves the provider root.')
        const results = []
        const visit = async directory => {
            let entries
            try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch(error) {
                if(error.code === 'ENOENT') return
                throw error
            }
            for(const entry of entries.sort((left, right) => left.name.localeCompare(right.name))){
                const entryPath = path.join(directory, entry.name)
                if(entry.isDirectory()) await visit(entryPath)
                else if(entry.isFile()) results.push(path.relative(root, entryPath).replaceAll('\\', '/'))
            }
        }
        await visit(start)
        return results
    }
}

function createResourceStack(providers){
    const list = Array.isArray(providers) ? providers.filter(Boolean) : []
    return {
        async getBuffer(resourcePath){
            for(const provider of list){
                const buf = await provider.getBuffer(resourcePath)
                if(buf){
                    return buf
                }
            }
            return null
        },
        async getText(resourcePath){
            for(const provider of list){
                const text = await provider.getText(resourcePath)
                if(text){
                    return text
                }
            }
            return null
        },
        async getJson(resourcePath){
            for(const provider of list){
                const json = await provider.getJson(resourcePath)
                if(json){
                    return json
                }
            }
            return null
        },
        async list(prefix = ''){
            const paths = new Map()
            for(const provider of list){
                if(typeof provider.list !== 'function') continue
                const entries = await provider.list(prefix)
                for(const entry of entries || []){
                    const normalized = String(entry || '').replaceAll('\\', '/')
                    const key = normalized.toLowerCase()
                    if(normalized && !paths.has(key)) paths.set(key, normalized)
                }
            }
            return [...paths.values()].sort((left, right) => left.localeCompare(right))
        }
    }
}

function splitResourceId(value, fallbackNamespace = 'minecraft'){
    const normalized = String(value || '').trim()
    const separator = normalized.indexOf(':')
    return separator >= 0
        ? { namespace: normalized.slice(0, separator), path: normalized.slice(separator + 1) }
        : { namespace: fallbackNamespace, path: normalized }
}

function selectModelReference(blockstate){
    if(blockstate?.variants && typeof blockstate.variants === 'object'){
        const keys = Object.keys(blockstate.variants).sort((left, right) => {
            if(left === '') return -1
            if(right === '') return 1
            return left.localeCompare(right)
        })
        for(const key of keys){
            const value = blockstate.variants[key]
            const selected = Array.isArray(value) ? value[0] : value
            const model = typeof selected === 'string' ? selected : selected?.model
            if(model) return model
        }
    }
    if(Array.isArray(blockstate?.multipart)){
        for(const part of blockstate.multipart){
            const selected = Array.isArray(part?.apply) ? part.apply[0] : part?.apply
            const model = typeof selected === 'string' ? selected : selected?.model
            if(model) return model
        }
    }
    return null
}

async function resolveInheritedModel(resourceStack, modelId, options = {}){
    const maxDepth = Number(options.maxDepth) || 16
    const seen = options.seen || new Set()
    const id = splitResourceId(modelId)
    const normalizedId = `${id.namespace}:${id.path}`
    if(seen.has(normalizedId)) throw new Error(`Model inheritance cycle detected at ${normalizedId}.`)
    if(seen.size >= maxDepth) throw new Error(`Model inheritance exceeds ${maxDepth} levels at ${normalizedId}.`)
    seen.add(normalizedId)
    const model = await resourceStack?.getJson(resolveModelPath(id.namespace, id.path))
    if(!model) return null
    const parent = model.parent
        ? await resolveInheritedModel(resourceStack, model.parent, { maxDepth, seen })
        : null
    return {
        id: normalizedId,
        textures: { ...(parent?.textures || {}), ...(model.textures || {}) },
        elements: Array.isArray(model.elements) ? model.elements : (parent?.elements || [])
    }
}

function dereferenceTexture(textures, value){
    let current = value
    const seen = new Set()
    while(typeof current === 'string' && current.startsWith('#')){
        if(seen.has(current)) throw new Error(`Texture reference cycle detected at ${current}.`)
        seen.add(current)
        current = textures[current.slice(1)]
    }
    return current || null
}

function selectTopTexture(model){
    for(const element of model?.elements || []){
        const reference = element?.faces?.up?.texture
        if(reference) return dereferenceTexture(model.textures || {}, reference)
    }
    for(const key of ['up', 'top', 'all', 'particle']){
        if(model?.textures?.[key]) return dereferenceTexture(model.textures, model.textures[key])
    }
    for(const key of Object.keys(model?.textures || {}).sort()){
        const value = dereferenceTexture(model.textures, model.textures[key])
        if(value) return value
    }
    return null
}

function readPngDimensions(bytes){
    const value = Buffer.from(bytes || [])
    const signature = '89504e470d0a1a0a'
    if(value.length < 24 || value.subarray(0, 8).toString('hex') !== signature) return null
    const width = value.readUInt32BE(16)
    const height = value.readUInt32BE(20)
    return width > 0 && height > 0 ? { width, height } : null
}

function firstAnimationFrame(dimensions, metadata){
    const animation = metadata?.animation || {}
    const frameWidth = Number.isInteger(animation.width) && animation.width > 0
        ? animation.width
        : dimensions.width
    const frameHeight = Number.isInteger(animation.height) && animation.height > 0
        ? animation.height
        : (dimensions.height >= frameWidth && dimensions.height % frameWidth === 0 ? frameWidth : dimensions.height)
    const columns = Math.max(1, Math.floor(dimensions.width / frameWidth))
    const first = Array.isArray(animation.frames) && animation.frames.length > 0 ? animation.frames[0] : 0
    const index = Math.max(0, Number(typeof first === 'object' ? first.index : first) || 0)
    return {
        x: (index % columns) * frameWidth,
        y: Math.floor(index / columns) * frameHeight,
        width: frameWidth,
        height: frameHeight
    }
}

async function resolveBlockTopTexture(resourceStack, blockId){
    if(!resourceStack) throw Object.assign(new Error('Minecraft resources are unavailable.'), { code: 'resources_unavailable', blockId })
    const block = splitResourceId(blockId)
    if(!block.namespace || !block.path) throw Object.assign(new Error(`Invalid block identifier: ${blockId}`), { code: 'invalid_block_id', blockId })
    const blockstate = await resourceStack.getJson(resolveBlockstatePath(block.namespace, block.path))
    if(!blockstate) throw Object.assign(new Error(`Blockstate not found for ${blockId}.`), { code: 'missing_blockstate', blockId })
    const modelId = selectModelReference(blockstate)
    if(!modelId) throw Object.assign(new Error(`No renderable model was found for ${blockId}.`), { code: 'missing_model', blockId })
    const model = await resolveInheritedModel(resourceStack, modelId)
    if(!model) throw Object.assign(new Error(`Model ${modelId} was not found for ${blockId}.`), { code: 'missing_model', blockId, modelId })
    const textureId = selectTopTexture(model)
    if(!textureId) throw Object.assign(new Error(`No top texture was found for ${blockId}.`), { code: 'missing_texture_reference', blockId, modelId })
    const texture = splitResourceId(textureId, block.namespace)
    const texturePath = resolveTexturePath(texture.namespace, texture.path)
    const bytes = await resourceStack.getBuffer(texturePath)
    if(!bytes) throw Object.assign(new Error(`Texture ${textureId} was not found for ${blockId}.`), { code: 'missing_texture', blockId, modelId, textureId })
    const dimensions = readPngDimensions(bytes)
    if(!dimensions) throw Object.assign(new Error(`Texture ${textureId} is not a valid PNG.`), { code: 'invalid_texture', blockId, modelId, textureId })
    const metadata = await resourceStack.getJson(`${texturePath}.mcmeta`).catch(() => null)
    return {
        blockId: `${block.namespace}:${block.path}`,
        modelId: model.id,
        textureId: `${texture.namespace}:${texture.path}`,
        bytes: Buffer.from(bytes),
        width: dimensions.width,
        height: dimensions.height,
        frame: firstAnimationFrame(dimensions, metadata)
    }
}

async function pathIsFile(filePath){
    try {
        return (await fs.stat(filePath)).isFile()
    } catch (err) {
        if(err.code === 'ENOENT') return false
        throw err
    }
}

async function listResourceContainers(directory){
    try {
        const entries = await fs.readdir(directory, { withFileTypes: true })
        return entries
            .filter(entry => entry.isDirectory() || (entry.isFile() && /\.(jar|zip)$/i.test(entry.name)))
            .map(entry => ({
                type: entry.isDirectory() ? 'directory' : 'jar',
                path: path.join(directory, entry.name)
            }))
            .sort((left, right) => left.path.localeCompare(right.path))
    } catch (err) {
        if(err.code === 'ENOENT') return []
        throw err
    }
}

function parseMavenCoordinate(value){
    const coordinate = String(value || '').trim()
    const parts = coordinate.split(':')
    if(parts.length < 3 || parts.length > 4 || parts.some(part => !SAFE_MAVEN_PART.test(part))){
        return null
    }
    const [group, artifact, version, classifier = null] = parts
    return { coordinate, group, artifact, version, classifier }
}

function resolveModstoreArtifactPath(modstoreDirectory, coordinate){
    const parsed = parseMavenCoordinate(coordinate)
    if(!parsed) return null
    const fileName = `${parsed.artifact}-${parsed.version}${parsed.classifier ? `-${parsed.classifier}` : ''}.jar`
    const candidate = path.resolve(
        modstoreDirectory,
        ...parsed.group.split('.'),
        parsed.artifact,
        parsed.version,
        fileName
    )
    const root = path.resolve(modstoreDirectory)
    const relative = path.relative(root, candidate)
    if(!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
    return candidate
}

async function readActiveModCoordinates(instanceDirectory){
    const listPath = path.join(instanceDirectory, 'forgeMods.list')
    try {
        const content = await fs.readFile(listPath, 'utf8')
        return content
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'))
    } catch (err) {
        if(err.code === 'ENOENT') return []
        throw err
    }
}

async function discoverProfileResources({ dataDirectory, profileId, minecraftVersion }){
    const resolvedDataDirectory = path.resolve(String(dataDirectory || ''))
    const resolvedProfileId = String(profileId || '').trim()
    const resolvedMinecraftVersion = String(minecraftVersion || '').trim()
    if(!dataDirectory || !resolvedDataDirectory) throw new Error('A Minecraft data directory is required.')
    if(!SAFE_PROFILE_ID.test(resolvedProfileId)) throw new Error('Profile id contains unsupported path characters.')
    if(!SAFE_MAVEN_PART.test(resolvedMinecraftVersion)) throw new Error('Minecraft version contains unsupported path characters.')

    const instanceDirectory = path.join(resolvedDataDirectory, 'instances', resolvedProfileId)
    const commonDirectory = path.join(resolvedDataDirectory, 'common')
    const looseResources = [
        ...await listResourceContainers(path.join(instanceDirectory, 'resourcepacks')),
        ...(await listResourceContainers(path.join(instanceDirectory, 'mods'))).filter(entry => entry.type === 'jar')
    ]
    const activeCoordinates = await readActiveModCoordinates(instanceDirectory)
    const modstoreDirectory = path.join(commonDirectory, 'modstore')
    const activeModJars = []
    const missingCoordinates = []
    for(const coordinate of activeCoordinates){
        const artifactPath = resolveModstoreArtifactPath(modstoreDirectory, coordinate)
        if(artifactPath && await pathIsFile(artifactPath)) activeModJars.push(artifactPath)
        else missingCoordinates.push(coordinate)
    }
    const minecraftJar = path.join(commonDirectory, 'versions', resolvedMinecraftVersion, `${resolvedMinecraftVersion}.jar`)

    return {
        dataDirectory: resolvedDataDirectory,
        profileId: resolvedProfileId,
        minecraftVersion: resolvedMinecraftVersion,
        looseResources,
        activeModJars: [...new Set(activeModJars)],
        missingCoordinates,
        minecraftJar: await pathIsFile(minecraftJar) ? minecraftJar : null
    }
}

function resolveBlockstatePath(namespace, block){
    return `assets/${namespace}/blockstates/${block}.json`
}

function resolveModelPath(namespace, model){
    return `assets/${namespace}/models/${model}.json`
}

function resolveTexturePath(namespace, texture){
    return `assets/${namespace}/textures/${texture}.png`
}

async function loadBlockstate(resourceStack, namespace, block){
    const pathKey = resolveBlockstatePath(namespace, block)
    return resourceStack.getJson(pathKey)
}

async function loadModel(resourceStack, namespace, model){
    const pathKey = resolveModelPath(namespace, model)
    return resourceStack.getJson(pathKey)
}

async function loadTexture(resourceStack, namespace, texture){
    const pathKey = resolveTexturePath(namespace, texture)
    return resourceStack.getBuffer(pathKey)
}

module.exports = {
    JarResourceProvider,
    ZipBufferResourceProvider,
    DirectoryResourceProvider,
    createResourceStack,
    dereferenceTexture,
    discoverProfileResources,
    firstAnimationFrame,
    loadBlockstate,
    loadModel,
    loadTexture,
    parseMavenCoordinate,
    readPngDimensions,
    resolveBlockTopTexture,
    resolveBlockstatePath,
    resolveInheritedModel,
    resolveModelPath,
    resolveModstoreArtifactPath,
    resolveTexturePath,
    selectModelReference,
    selectTopTexture,
    splitResourceId
}
