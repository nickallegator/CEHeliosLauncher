/**
 * minecraft-resources
 * Shared resource resolver for Minecraft assets (blockstates, models, textures).
 * Launcher uses local jars; web can plug in a fetch-based provider later.
 */

'use strict'

const fs = require('fs/promises')
const path = require('path')
const AdmZip = require('adm-zip')

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
    resolveBlockstatePath,
    resolveModelPath,
    resolveTexturePath,
    loadBlockstate,
    loadModel,
    loadTexture
}
