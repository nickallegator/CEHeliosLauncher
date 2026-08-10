const path = require('path')
const { parentPort } = require('worker_threads')
const { buildSchematicMesh } = require(path.resolve(process.cwd(), 'libraries', 'schematics-visualizer'))

function computeVariantSeed(blockId, block){
    let hash = 2166136261
    const str = `${blockId}:${block.x},${block.y},${block.z}`
    for(let i = 0; i < str.length; i++){
        hash ^= str.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
    }
    return hash >>> 0
}

function getTintColor(blockId, _state, tintIndex){
    if(tintIndex == null){
        return null
    }
    const id = String(blockId || '').toLowerCase()
    if(id.includes('water')){
        return [0.25, 0.46, 0.89]
    }
    if(id.includes('grass')){
        return tintIndex === 1 ? [0.4, 0.65, 0.3] : [0.56, 0.74, 0.35]
    }
    if(id.includes('leaves') || id.includes('vine')){
        return [0.47, 0.72, 0.32]
    }
    if(id.includes('fern') || id.includes('tall_grass') || id.includes('seagrass')){
        return [0.48, 0.74, 0.34]
    }
    return null
}

function collectTransferBuffers(mesh){
    const buffers = []
    if(!mesh){
        return buffers
    }
    const add = (value) => {
        if(value && value.buffer){
            buffers.push(value.buffer)
        }
    }
    const collect = (entry) => {
        if(!entry){
            return
        }
        add(entry.positions)
        add(entry.normals)
        add(entry.colors)
        add(entry.uvs)
        add(entry.emissive)
        add(entry.ao)
    }
    collect(mesh.opaque)
    collect(mesh.cutout)
    collect(mesh.translucent)
    return buffers
}

parentPort.on('message', (message) => {
    if(!message || message.type !== 'build'){
        return
    }
    const { id, schematic, registry, options, atlasMapping } = message
    try {
        const mesh = buildSchematicMesh(schematic, registry, {
            center: options?.center || [0, 0, 0],
            paletteColors: options?.paletteColors || [],
            cullFaces: options?.cullFaces !== false,
            coplanarBias: options?.coplanarBias !== false,
            tintProvider: getTintColor,
            variantSeedFn: (block, paletteEntry) => computeVariantSeed(paletteEntry?.block || 'minecraft:stone', block),
            alphaResolver: (textureId) => {
                const entry = atlasMapping?.[textureId]
                return entry?.alphaMode || 'opaque'
            },
            textureResolver: (textureId) => {
                const entry = atlasMapping?.[textureId]
                if(!entry){
                    return null
                }
                return {
                    uv: [entry.u0, entry.v0, entry.u1, entry.v1],
                    alphaMode: entry.alphaMode || 'opaque'
                }
            }
        })
        const transfers = collectTransferBuffers(mesh)
        parentPort.postMessage({ type: 'result', id, ok: true, mesh }, transfers)
    } catch (err) {
        parentPort.postMessage({ type: 'result', id, ok: false, error: err?.message || String(err) })
    }
})

parentPort.postMessage({ type: 'ready' })
