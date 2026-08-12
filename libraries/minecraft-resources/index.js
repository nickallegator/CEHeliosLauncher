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
    }

    _ensureZip(){
        if(!this._zip){
            this._zip = new AdmZip(this.jarPath)
        }
        return this._zip
    }

    getBuffer(resourcePath){
        const zip = this._ensureZip()
        const entry = zip.getEntry(resourcePath)
        if(!entry){
            return null
        }
        return entry.getData()
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
        }
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
    DirectoryResourceProvider,
    createResourceStack,
    discoverProfileResources,
    parseMavenCoordinate,
    resolveModstoreArtifactPath,
    resolveBlockstatePath,
    resolveModelPath,
    resolveTexturePath,
    loadBlockstate,
    loadModel,
    loadTexture
}
