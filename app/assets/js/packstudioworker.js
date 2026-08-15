'use strict'

const path = require('path')
const { parentPort } = require('worker_threads')

function loadBuilder() {
    const candidates = [
        process.resourcesPath ? path.join(process.resourcesPath, 'libraries', 'resource-pack-studio', 'builder') : null,
        path.resolve(process.cwd(), 'libraries', 'resource-pack-studio', 'builder'),
        path.resolve(__dirname, '..', '..', '..', 'libraries', 'resource-pack-studio', 'builder')
    ].filter(Boolean)
    for(const candidate of candidates) {
        try { return require(candidate) } catch(error) {
            if(error?.code !== 'MODULE_NOT_FOUND') throw error
        }
    }
    throw new Error('AG Launcher Pack Studio builder is missing from the application resources.')
}

const { buildPack } = loadBuilder()

const send = message => parentPort ? parentPort.postMessage(message) : process.send?.(message)

async function handleMessage(message) {
    if(message?.type !== 'build') return
    try {
        const result = await buildPack({
            ...message.payload,
            onProgress: progress => send({ type: 'progress', progress })
        })
        send({ type: 'complete', result })
    } catch(error) {
        send({ type: 'error', error: { message: error.message, code: error.code || 'pack_studio_build_failed' } })
    }
}

if(parentPort) parentPort.on('message', handleMessage)
else process.on('message', handleMessage)
