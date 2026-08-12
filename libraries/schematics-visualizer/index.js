/**
 * schematics-visualizer
 * Lightweight blockstate/model resolver for schematic previews.
 * This module is renderer-agnostic and produces raw mesh buffers.
 */

'use strict'

const DEFAULT_BLOCKSTATE = {
    variants: {
        normal: { model: 'block/cube_all' }
    }
}

const DEFAULT_MODEL = {
    elements: [
        {
            from: [0, 0, 0],
            to: [16, 16, 16]
        }
    ]
}

const FACE_NORMALS = {
    north: [0, 0, -1],
    south: [0, 0, 1],
    west: [-1, 0, 0],
    east: [1, 0, 0],
    up: [0, 1, 0],
    down: [0, -1, 0]
}

const FACE_ORDER = ['north', 'south', 'west', 'east', 'up', 'down']

function getFacePlaneValue(faceName, from, to){
    if(faceName === 'north'){
        return from[2]
    }
    if(faceName === 'south'){
        return to[2]
    }
    if(faceName === 'west'){
        return from[0]
    }
    if(faceName === 'east'){
        return to[0]
    }
    if(faceName === 'down'){
        return from[1]
    }
    if(faceName === 'up'){
        return to[1]
    }
    return null
}

function hashVariantSeed(value){
    let hash = 2166136261
    const str = String(value)
    for(let i=0; i<str.length; i++){
        hash ^= str.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
    }
    return hash >>> 0
}

function pickWeightedVariant(models, seed){
    if(!Array.isArray(models) || models.length === 0){
        return null
    }
    const total = models.reduce((sum, entry) => sum + (Number(entry.weight) > 0 ? Number(entry.weight) : 1), 0)
    let roll = seed % total
    for(const entry of models){
        const weight = Number(entry.weight) > 0 ? Number(entry.weight) : 1
        if(roll < weight){
            return entry
        }
        roll -= weight
    }
    return models[0]
}

function normalizeModelId(modelId, defaultNamespace = 'minecraft'){
    if(!modelId){
        return modelId
    }
    if(modelId.includes(':')){
        return modelId
    }
    return `${defaultNamespace}:${modelId}`
}

function resolveBlockstateModels(blockId, state, registry) {
    const blockstates = registry?.blockstates || {}
    const blockstate = blockstates[blockId] || DEFAULT_BLOCKSTATE

    if(Array.isArray(blockstate.multipart)){
        const models = []
        for(const part of blockstate.multipart){
            if(matchWhen(state, part.when)){
                models.push(...normalizeApply(part.apply))
            }
        }
        if(models.length > 0){
            return models
        }
    }

    const variants = blockstate.variants || DEFAULT_BLOCKSTATE.variants
    const keys = Object.keys(variants)
    for(const key of keys){
        if(matchVariantKey(state, key)){
            return normalizeApply(variants[key])
        }
    }

    const fallback = variants.normal || variants[''] || Object.values(variants)[0]
    return normalizeApply(fallback || { model: 'block/cube_all' })
}

function resolveModel(modelId, registry, depth = 0){
    if(depth > 6){
        return DEFAULT_MODEL
    }
    const models = registry?.models || {}
    const normalizedId = normalizeModelId(modelId)
    const model = models[modelId] || models[normalizedId] || DEFAULT_MODEL
    if(model.parent){
        const parentId = normalizeModelId(model.parent)
        const parent = resolveModel(parentId, registry, depth + 1)
        return {
            textures: { ...(parent.textures || {}), ...(model.textures || {}) },
            elements: model.elements || parent.elements || DEFAULT_MODEL.elements
        }
    }
    return {
        textures: model.textures || {},
        elements: model.elements || DEFAULT_MODEL.elements
    }
}

function buildElementFaces(from, to, elementFaces){
    const fx = from[0] / 16
    const fy = from[1] / 16
    const fz = from[2] / 16
    const tx = to[0] / 16
    const ty = to[1] / 16
    const tz = to[2] / 16
    const eps = 0.000001
    const hasX = Math.abs(tx - fx) > eps
    const hasY = Math.abs(ty - fy) > eps
    const hasZ = Math.abs(tz - fz) > eps

    const faceDefs = [
        // south (+z)
        { name: 'south', normal: FACE_NORMALS.south, verts: [
            [fx, fy, tz], [tx, fy, tz], [tx, ty, tz],
            [fx, fy, tz], [tx, ty, tz], [fx, ty, tz]
        ]},
        // north (-z)
        { name: 'north', normal: FACE_NORMALS.north, verts: [
            [tx, fy, fz], [fx, fy, fz], [fx, ty, fz],
            [tx, fy, fz], [fx, ty, fz], [tx, ty, fz]
        ]},
        // east (+x)
        { name: 'east', normal: FACE_NORMALS.east, verts: [
            [tx, fy, tz], [tx, fy, fz], [tx, ty, fz],
            [tx, fy, tz], [tx, ty, fz], [tx, ty, tz]
        ]},
        // west (-x)
        { name: 'west', normal: FACE_NORMALS.west, verts: [
            [fx, fy, fz], [fx, fy, tz], [fx, ty, tz],
            [fx, fy, fz], [fx, ty, tz], [fx, ty, fz]
        ]},
        // up (+y)
        { name: 'up', normal: FACE_NORMALS.up, verts: [
            [fx, ty, tz], [tx, ty, tz], [tx, ty, fz],
            [fx, ty, tz], [tx, ty, fz], [fx, ty, fz]
        ]},
        // down (-y)
        { name: 'down', normal: FACE_NORMALS.down, verts: [
            [fx, fy, fz], [tx, fy, fz], [tx, fy, tz],
            [fx, fy, fz], [tx, fy, tz], [fx, fy, tz]
        ]}
    ]

    const thicknessFiltered = faceDefs.filter((face) => {
        if(!hasX && (face.name === 'east' || face.name === 'west')){
            return false
        }
        if(!hasY && (face.name === 'up' || face.name === 'down')){
            return false
        }
        if(!hasZ && (face.name === 'north' || face.name === 'south')){
            return false
        }
        return true
    })

    if(elementFaces && Object.keys(elementFaces).length > 0){
        return thicknessFiltered.filter(face => elementFaces[face.name])
    }

    return thicknessFiltered
}

function buildFaceSelection(elementFaces, faceMask){
    if(!elementFaces && !faceMask){
        return null
    }
    const selection = {}
    for(const name of FACE_ORDER){
        if(faceMask && faceMask[name] === false){
            continue
        }
        if(elementFaces){
            if(elementFaces[name]){
                selection[name] = true
            }
        } else {
            selection[name] = true
        }
    }
    return selection
}

function buildBlockMesh(blockId, state, registry, options = {}){
    const models = resolveBlockstateModels(blockId, state, registry)
    const variantSeed = Number.isFinite(options.variantSeed)
        ? options.variantSeed
        : (options.variantSeed != null ? hashVariantSeed(options.variantSeed) : null)
    let activeModels = models
    let chosenVariant = null
    if(variantSeed != null && Array.isArray(models) && models.length > 1){
        chosenVariant = pickWeightedVariant(models, variantSeed)
        activeModels = chosenVariant ? [chosenVariant] : models.slice(0, 1)
    }
    const positions = []
    const normals = []
    const uvs = []
    const tints = []
    const emissive = []
    const ao = []
    const positionsCutout = []
    const normalsCutout = []
    const uvsCutout = []
    const tintsCutout = []
    const emissiveCutout = []
    const aoCutout = []
    const positionsTrans = []
    const normalsTrans = []
    const uvsTrans = []
    const tintsTrans = []
    const emissiveTrans = []
    const aoTrans = []
    const debug = options.debug || null
    const debugBlocks = debug?.blocks || []
    const shouldDebug = Boolean(debug?.enabled && debugBlocks.includes(blockId))
    const debugLog = typeof debug?.log === 'function' ? debug.log : console.log
    const blockstatePresent = Boolean(registry?.blockstates?.[blockId])
    const debugPlaneCounts = shouldDebug ? new Map() : null
    let hasCoplanar = false
    const debugBounds = shouldDebug ? new Map() : null
    const coplanarBiasEnabled = Boolean(options.coplanarBias)
    const planeCounts = coplanarBiasEnabled ? new Map() : null
    const planeKeyBase = `${blockId}:${variantSeed ?? 'default'}`

    if(planeCounts){
        for(const modelEntry of activeModels){
            const modelId = normalizeModelId(modelEntry.model || 'block/cube_all')
            const model = resolveModel(modelId, registry)
            const rotX = normalizeRotation(modelEntry.x)
            const rotY = normalizeRotation(modelEntry.y)
            const elements = Array.isArray(model.elements) ? model.elements : DEFAULT_MODEL.elements
            for(const element of elements){
                const from = Array.isArray(element.from) ? element.from : [0, 0, 0]
                const to = Array.isArray(element.to) ? element.to : [16, 16, 16]
                const faceSelection = buildFaceSelection(element.faces, options.faceMask)
                const faces = buildElementFaces(from, to, faceSelection)
                for(const face of faces){
                    const faceDef = element.faces?.[face.name] || {}
                    if(faceDef.cullface && options.faceMask && options.faceMask[faceDef.cullface] === false){
                        continue
                    }
                    const planeValue = getFacePlaneValue(face.name, from, to)
                    const planeKey = `${planeKeyBase}|${face.name}|${planeValue}|${rotX}|${rotY}`
                    planeCounts.set(planeKey, (planeCounts.get(planeKey) || 0) + 1)
                }
            }
        }
    }

    for(const modelEntry of activeModels){
        const modelId = normalizeModelId(modelEntry.model || 'block/cube_all')
        const model = resolveModel(modelId, registry)
        const rotX = normalizeRotation(modelEntry.x)
        const rotY = normalizeRotation(modelEntry.y)
        const uvlock = Boolean(modelEntry.uvlock)
        if(shouldDebug){
            debugLog('[schematics-visualizer] model', {
                blockId,
                modelId,
                rotX,
                rotY,
                uvlock,
                modelEntry,
                blockstatePresent,
                elementCount: Array.isArray(model?.elements) ? model.elements.length : 0,
                textureKeys: Object.keys(model?.textures || {}),
                variantSeed,
                variantChoice: chosenVariant ? {
                    model: chosenVariant.model,
                    x: chosenVariant.x,
                    y: chosenVariant.y,
                    weight: chosenVariant.weight
                } : null
            })
        }

        const elements = Array.isArray(model.elements) ? model.elements : DEFAULT_MODEL.elements
        for(let elementIndex = 0; elementIndex < elements.length; elementIndex++){
            const element = elements[elementIndex]
            const from = Array.isArray(element.from) ? element.from : [0, 0, 0]
            const to = Array.isArray(element.to) ? element.to : [16, 16, 16]
            const faceSelection = buildFaceSelection(element.faces, options.faceMask)
            const faces = buildElementFaces(from, to, faceSelection)
            if(debugBounds){
                const key = `${elementIndex}:${from.join(',')}:${to.join(',')}`
                debugBounds.set(key, (debugBounds.get(key) || 0) + 1)
            }
            for(const face of faces){
                const rotatedNormal = rotateNormal(face.normal, rotX, rotY)
                const faceDef = element.faces?.[face.name] || {}
                if(faceDef.cullface && options.faceMask && options.faceMask[faceDef.cullface] === false){
                    continue
                }
                if(debugPlaneCounts){
                    let planeValue = null
                    if(face.name === 'north'){
                        planeValue = from[2]
                    } else if(face.name === 'south'){
                        planeValue = to[2]
                    } else if(face.name === 'west'){
                        planeValue = from[0]
                    } else if(face.name === 'east'){
                        planeValue = to[0]
                    } else if(face.name === 'down'){
                        planeValue = from[1]
                    } else if(face.name === 'up'){
                        planeValue = to[1]
                    }
                    const planeKey = `${face.name}:${planeValue}`
                    debugPlaneCounts.set(planeKey, (debugPlaneCounts.get(planeKey) || 0) + 1)
                }
                const textureRef = faceDef.texture
                const textureId = resolveTextureRef(model, textureRef)
                let missingTextureKey = null
                if(typeof textureRef === 'string' && textureRef.startsWith('#')){
                    const key = textureRef.slice(1)
                    const textures = model?.textures || {}
                    if(!textures[key] && !textures.all && !textures.texture){
                        missingTextureKey = key
                    }
                }
                const faceUv = normalizeFaceUv(faceDef.uv, from, to, face.name)
                const atlasInfo = options.textureResolver ? options.textureResolver(textureId) : null
                const atlasUv = atlasInfo?.uv || null
                const alphaMode = atlasInfo?.alphaMode || 'opaque'
                let quadUvs = buildQuadUvs()
                const faceRotation = normalizeFaceRotation(faceDef.rotation)
                if(faceRotation){
                    rotateQuadUvsInPlace(quadUvs, faceRotation)
                }
                if(uvlock){
                    const uvlockFace = faceNameFromNormal(rotatedNormal)
                    rotateQuadUvsInPlace(quadUvs, getUvlockTurns(rotX, rotY, uvlockFace))
                }
                const localUvs = quadUvs.map((uv) => [uv[0], uv[1]])
                quadUvs = applyFaceUvs(quadUvs, faceUv)
                if(atlasUv){
                    quadUvs = applyAtlasUvs(quadUvs, atlasUv)
                }
                let faceBias = 0
                if(planeCounts){
                    const planeValue = getFacePlaneValue(face.name, from, to)
                    const planeKey = `${planeKeyBase}|${face.name}|${planeValue}|${rotX}|${rotY}`
                    const count = planeCounts.get(planeKey) || 0
                    if(count > 1){
                        hasCoplanar = true
                        faceBias = 0.001 * (elementIndex + 1)
                    }
                }
                if(shouldDebug){
                    const mappedUvs = quadUvs.map((uv) => [uv[0], uv[1]])
                    debugLog('[schematics-visualizer] face', {
                        blockId,
                        modelId,
                        elementIndex,
                        face: face.name,
                        elementFrom: from,
                        elementTo: to,
                        elementRotation: element.rotation || null,
                        faceDef,
                        textureRef,
                        textureId,
                        missingTextureKey,
                        faceUv,
                        faceRotation,
                        uvlock,
                        atlasUv,
                        localUvs,
                        mappedUvs
                    })
                }
                let targetPositions = positions
                let targetNormals = normals
                let targetUvs = uvs
                let targetTints = tints
                let targetEmissive = emissive
                let targetAo = ao
                if(alphaMode === 'translucent'){
                    targetPositions = positionsTrans
                    targetNormals = normalsTrans
                    targetUvs = uvsTrans
                    targetTints = tintsTrans
                    targetEmissive = emissiveTrans
                    targetAo = aoTrans
                } else if(alphaMode === 'cutout'){
                    targetPositions = positionsCutout
                    targetNormals = normalsCutout
                    targetUvs = uvsCutout
                    targetTints = tintsCutout
                    targetEmissive = emissiveCutout
                    targetAo = aoCutout
                }
                const tint = options.tintProvider ? options.tintProvider(blockId, state, faceDef.tintindex) : null
                const tintColor = Array.isArray(tint) && tint.length === 3 ? tint : [1, 1, 1]
                const isEmissive = isEmissiveTexture(textureId, options.emissiveTextures)
                const emissiveValue = isEmissive ? 1 : 0
                const aoValue = computeAoFromNormal(rotatedNormal)
                for(const vert of face.verts){
                    let rotated = applyElementRotation(vert, element.rotation)
                    rotated = applyRotation(rotated, rotX, rotY)
                    if(faceBias){
                        const biasNormal = applyElementRotationToNormal(rotatedNormal, element.rotation)
                        rotated = [
                            rotated[0] + biasNormal[0] * faceBias,
                            rotated[1] + biasNormal[1] * faceBias,
                            rotated[2] + biasNormal[2] * faceBias
                        ]
                    }
                    targetPositions.push(rotated[0], rotated[1], rotated[2])
                    const elementNormal = applyElementRotationToNormal(rotatedNormal, element.rotation)
                    targetNormals.push(elementNormal[0], elementNormal[1], elementNormal[2])
                    const uv = quadUvs.shift() || [0, 0]
                    targetUvs.push(uv[0], uv[1])
                    targetTints.push(tintColor[0], tintColor[1], tintColor[2])
                    targetEmissive.push(emissiveValue)
                    targetAo.push(aoValue)
                }
            }
        }
    }

    if(debugPlaneCounts){
        const duplicates = []
        for(const [key, count] of debugPlaneCounts.entries()){
            if(count > 1){
                duplicates.push({ key, count })
            }
        }
        if(duplicates.length > 0){
            debugLog('[schematics-visualizer] duplicate planes', {
                blockId,
                duplicates
            })
        }
    }
    if(debugBounds){
        const repeated = []
        for(const [key, count] of debugBounds.entries()){
            if(count > 1){
                repeated.push({ key, count })
            }
        }
        if(repeated.length > 0){
            debugLog('[schematics-visualizer] duplicate elements', {
                blockId,
                repeated
            })
        }
    }

    return {
        hasCoplanar,
        opaque: { positions, normals, uvs, tints, emissive, ao },
        cutout: { positions: positionsCutout, normals: normalsCutout, uvs: uvsCutout, tints: tintsCutout, emissive: emissiveCutout, ao: aoCutout },
        translucent: { positions: positionsTrans, normals: normalsTrans, uvs: uvsTrans, tints: tintsTrans, emissive: emissiveTrans, ao: aoTrans }
    }
}

function buildSchematicMesh(schematic, registry, options = {}){
    if(!schematic || !Array.isArray(schematic.blocks)){
        return null
    }
    const center = options.center || [0, 0, 0]
    const paletteColors = Array.isArray(options.paletteColors) ? options.paletteColors : []
    const blockMeshCache = new Map()
    const fullCubeCache = new Map()
    const occluderCache = new Map()
    const occupied = new Map()
    const occluderSet = new Set()
    const positions = []
    const normals = []
    const colors = []
    const uvs = []
    const emissive = []
    const ao = []
    const positionsCutout = []
    const normalsCutout = []
    const colorsCutout = []
    const uvsCutout = []
    const emissiveCutout = []
    const aoCutout = []
    const positionsTrans = []
    const normalsTrans = []
    const colorsTrans = []
    const uvsTrans = []
    const emissiveTrans = []
    const aoTrans = []

    let hasCoplanar = false
    for(const block of schematic.blocks){
        occupied.set(`${block.x},${block.y},${block.z}`, block)
    }

    if(options.cullFaces){
        for(const block of schematic.blocks){
            const paletteEntry = schematic.palette?.[block.p]
            const blockId = paletteEntry?.block || 'minecraft:stone'
            const state = paletteEntry?.state
            const cacheKey = state ? `${blockId}:${JSON.stringify(state)}` : blockId
            let isOccluder = occluderCache.get(cacheKey)
            if(isOccluder == null){
                let isFullCube = fullCubeCache.get(cacheKey)
                if(isFullCube == null){
                    isFullCube = isFullCubeBlock(blockId, state, registry)
                    fullCubeCache.set(cacheKey, isFullCube)
                }
                isOccluder = isFullCube && isOpaqueBlock(blockId, state, registry, options)
                occluderCache.set(cacheKey, isOccluder)
            }
            if(isOccluder){
                occluderSet.add(`${block.x},${block.y},${block.z}`)
            }
        }
    }

    const variantSeedFn = typeof options.variantSeedFn === 'function' ? options.variantSeedFn : null

    for(const block of schematic.blocks){
        const paletteEntry = schematic.palette?.[block.p]
        const blockId = paletteEntry?.block || 'minecraft:stone'
        const state = paletteEntry?.state
        const faceMask = options.cullFaces ? buildFaceMask(block, occluderSet) : null
        const faceMaskKey = faceMask ? `:${faceMaskToInt(faceMask)}` : ''
        const variantSeed = variantSeedFn ? variantSeedFn(block, paletteEntry) : null
        const variantKey = variantSeed != null ? `:v${variantSeed}` : ''
        const cacheKey = state ? `${blockId}:${JSON.stringify(state)}${faceMaskKey}${variantKey}` : `${blockId}${faceMaskKey}${variantKey}`
        let mesh = blockMeshCache.get(cacheKey)
        if(!mesh){
            mesh = buildBlockMesh(blockId, state, registry, {
                faceMask,
                textureResolver: options.textureResolver,
                tintProvider: options.tintProvider,
                debug: options.debug,
                variantSeed
            })
            blockMeshCache.set(cacheKey, mesh)
        }
        if(mesh.hasCoplanar){
            hasCoplanar = true
        }
        const color = options.usePaletteColors === false
            ? [1, 1, 1]
            : (paletteColors[block.p] || [0.7, 0.7, 0.7])
        for(let i=0; i<mesh.opaque.positions.length; i+=3){
            positions.push(
                mesh.opaque.positions[i] + block.x - center[0],
                mesh.opaque.positions[i + 1] + block.y - center[1],
                mesh.opaque.positions[i + 2] + block.z - center[2]
            )
            normals.push(
                mesh.opaque.normals[i],
                mesh.opaque.normals[i + 1],
                mesh.opaque.normals[i + 2]
            )
            const tintIndex = i
            const tint = mesh.opaque.tints?.length ? [
                mesh.opaque.tints[tintIndex],
                mesh.opaque.tints[tintIndex + 1],
                mesh.opaque.tints[tintIndex + 2]
            ] : [1, 1, 1]
            colors.push(color[0] * tint[0], color[1] * tint[1], color[2] * tint[2])
            emissive.push(mesh.opaque.emissive?.[tintIndex / 3] ?? 0)
            ao.push(mesh.opaque.ao?.[tintIndex / 3] ?? 1)
        }
        for(let i=0; i<mesh.opaque.uvs.length; i+=2){
            uvs.push(mesh.opaque.uvs[i], mesh.opaque.uvs[i + 1])
        }

        for(let i=0; i<mesh.cutout.positions.length; i+=3){
            positionsCutout.push(
                mesh.cutout.positions[i] + block.x - center[0],
                mesh.cutout.positions[i + 1] + block.y - center[1],
                mesh.cutout.positions[i + 2] + block.z - center[2]
            )
            normalsCutout.push(
                mesh.cutout.normals[i],
                mesh.cutout.normals[i + 1],
                mesh.cutout.normals[i + 2]
            )
            const tintIndex = i
            const tint = mesh.cutout.tints?.length ? [
                mesh.cutout.tints[tintIndex],
                mesh.cutout.tints[tintIndex + 1],
                mesh.cutout.tints[tintIndex + 2]
            ] : [1, 1, 1]
            colorsCutout.push(color[0] * tint[0], color[1] * tint[1], color[2] * tint[2])
            emissiveCutout.push(mesh.cutout.emissive?.[tintIndex / 3] ?? 0)
            aoCutout.push(mesh.cutout.ao?.[tintIndex / 3] ?? 1)
        }
        for(let i=0; i<mesh.cutout.uvs.length; i+=2){
            uvsCutout.push(mesh.cutout.uvs[i], mesh.cutout.uvs[i + 1])
        }

        for(let i=0; i<mesh.translucent.positions.length; i+=3){
            positionsTrans.push(
                mesh.translucent.positions[i] + block.x - center[0],
                mesh.translucent.positions[i + 1] + block.y - center[1],
                mesh.translucent.positions[i + 2] + block.z - center[2]
            )
            normalsTrans.push(
                mesh.translucent.normals[i],
                mesh.translucent.normals[i + 1],
                mesh.translucent.normals[i + 2]
            )
            const tintIndex = i
            const tint = mesh.translucent.tints?.length ? [
                mesh.translucent.tints[tintIndex],
                mesh.translucent.tints[tintIndex + 1],
                mesh.translucent.tints[tintIndex + 2]
            ] : [1, 1, 1]
            colorsTrans.push(color[0] * tint[0], color[1] * tint[1], color[2] * tint[2])
            emissiveTrans.push(mesh.translucent.emissive?.[tintIndex / 3] ?? 0)
            aoTrans.push(mesh.translucent.ao?.[tintIndex / 3] ?? 1)
        }
        for(let i=0; i<mesh.translucent.uvs.length; i+=2){
            uvsTrans.push(mesh.translucent.uvs[i], mesh.translucent.uvs[i + 1])
        }
    }

    return {
        hasCoplanar,
        opaque: {
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            colors: new Float32Array(colors),
            uvs: new Float32Array(uvs),
            emissive: new Float32Array(emissive),
            ao: new Float32Array(ao)
        },
        cutout: {
            positions: new Float32Array(positionsCutout),
            normals: new Float32Array(normalsCutout),
            colors: new Float32Array(colorsCutout),
            uvs: new Float32Array(uvsCutout),
            emissive: new Float32Array(emissiveCutout),
            ao: new Float32Array(aoCutout)
        },
        translucent: {
            positions: new Float32Array(positionsTrans),
            normals: new Float32Array(normalsTrans),
            colors: new Float32Array(colorsTrans),
            uvs: new Float32Array(uvsTrans),
            emissive: new Float32Array(emissiveTrans),
            ao: new Float32Array(aoTrans)
        }
    }
}

function computeAoFromNormal(normal){
    const ny = normal[1]
    if(ny > 0.5){
        return 1
    }
    if(ny < -0.5){
        return 0.7
    }
    return 0.85
}

function isEmissiveTexture(textureId, emissiveTextures){
    if(!textureId){
        return false
    }
    if(emissiveTextures && emissiveTextures.has(textureId)){
        return true
    }
    const id = textureId.toLowerCase()
    return (
        id.includes('torch') ||
        id.includes('lantern') ||
        id.includes('glowstone') ||
        id.includes('sea_lantern') ||
        id.includes('shroomlight') ||
        id.includes('redstone_lamp') ||
        id.includes('end_rod') ||
        id.includes('campfire') ||
        id.includes('soul_lantern') ||
        id.includes('soul_torch')
    )
}

function isFullCubeBlock(blockId, state, registry){
    const models = resolveBlockstateModels(blockId, state, registry)
    if(models.length !== 1){
        return false
    }
    const modelEntry = models[0]
    if(normalizeRotation(modelEntry.x) !== 0 || normalizeRotation(modelEntry.y) !== 0){
        return false
    }
    const model = resolveModel(modelEntry.model || 'block/cube_all', registry)
    if(!model || !Array.isArray(model.elements) || model.elements.length !== 1){
        return false
    }
    const element = model.elements[0]
    const from = Array.isArray(element.from) ? element.from : [0, 0, 0]
    const to = Array.isArray(element.to) ? element.to : [16, 16, 16]
    return (
        from[0] === 0 && from[1] === 0 && from[2] === 0 &&
        to[0] === 16 && to[1] === 16 && to[2] === 16
    )
}

function isOpaqueBlock(blockId, state, registry, options){
    if(typeof options?.alphaResolver !== 'function'){
        return true
    }
    const models = resolveBlockstateModels(blockId, state, registry)
    for(const modelEntry of models){
        const modelId = normalizeModelId(modelEntry.model || 'block/cube_all')
        const model = resolveModel(modelId, registry)
        const textureIds = collectTextureIdsForModel(model)
        for(const textureId of textureIds){
            const mode = options.alphaResolver(textureId)
            if(mode && mode !== 'opaque'){
                return false
            }
        }
    }
    return true
}

function buildFaceMask(block, fullCubeSet){
    if(!fullCubeSet.has(`${block.x},${block.y},${block.z}`)){
        return null
    }
    return {
        north: !fullCubeSet.has(`${block.x},${block.y},${block.z - 1}`),
        south: !fullCubeSet.has(`${block.x},${block.y},${block.z + 1}`),
        west: !fullCubeSet.has(`${block.x - 1},${block.y},${block.z}`),
        east: !fullCubeSet.has(`${block.x + 1},${block.y},${block.z}`),
        up: !fullCubeSet.has(`${block.x},${block.y + 1},${block.z}`),
        down: !fullCubeSet.has(`${block.x},${block.y - 1},${block.z}`)
    }
}

function faceMaskToInt(mask){
    if(!mask){
        return 0
    }
    let value = 0
    FACE_ORDER.forEach((name, index) => {
        if(mask[name]){
            value |= (1 << index)
        }
    })
    return value
}

function normalizeApply(entry){
    if(Array.isArray(entry)){
        return entry.filter(Boolean).map(item => normalizeApply(item)).flat()
    }
    if(entry && typeof entry === 'object'){
        return [{
            model: entry.model || 'block/cube_all',
            x: entry.x || 0,
            y: entry.y || 0
        }]
    }
    if(typeof entry === 'string'){
        return [{ model: entry, x: 0, y: 0 }]
    }
    return [{ model: 'block/cube_all', x: 0, y: 0 }]
}

function normalizeRotation(value){
    if(!Number.isFinite(value)){
        return 0
    }
    const snapped = Math.round(value / 90) * 90
    return ((snapped % 360) + 360) % 360
}

function applyRotation(vertex, rotX, rotY){
    let x = vertex[0] - 0.5
    let y = vertex[1] - 0.5
    let z = vertex[2] - 0.5

    if(rotY){
        const rad = rotY * Math.PI / 180
        const cos = Math.cos(rad)
        const sin = Math.sin(rad)
        const nx = x * cos - z * sin
        const nz = x * sin + z * cos
        x = nx
        z = nz
    }
    if(rotX){
        const rad = rotX * Math.PI / 180
        const cos = Math.cos(rad)
        const sin = Math.sin(rad)
        const ny = y * cos - z * sin
        const nz = y * sin + z * cos
        y = ny
        z = nz
    }

    return [x + 0.5, y + 0.5, z + 0.5]
}

function applyElementRotation(vertex, rotation){
    if(!rotation || !rotation.axis || !Array.isArray(rotation.origin)){
        return vertex
    }
    const origin = [
        rotation.origin[0] / 16,
        rotation.origin[1] / 16,
        rotation.origin[2] / 16
    ]
    let x = vertex[0] - origin[0]
    let y = vertex[1] - origin[1]
    let z = vertex[2] - origin[2]
    const angle = (rotation.angle || 0) * Math.PI / 180
    if(rotation.rescale && angle){
        const cos = Math.cos(angle)
        const scale = cos !== 0 ? 1 / cos : 1
        if(rotation.axis === 'x'){
            y *= scale
            z *= scale
        } else if(rotation.axis === 'y'){
            x *= scale
            z *= scale
        } else if(rotation.axis === 'z'){
            x *= scale
            y *= scale
        }
    }
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    if(rotation.axis === 'x'){
        const ny = y * cos - z * sin
        const nz = y * sin + z * cos
        y = ny
        z = nz
    } else if(rotation.axis === 'y'){
        const nx = x * cos - z * sin
        const nz = x * sin + z * cos
        x = nx
        z = nz
    } else if(rotation.axis === 'z'){
        const nx = x * cos - y * sin
        const ny = x * sin + y * cos
        x = nx
        y = ny
    }
    return [x + origin[0], y + origin[1], z + origin[2]]
}

function applyElementRotationToNormal(normal, rotation){
    if(!rotation || !rotation.axis){
        return normal
    }
    let x = normal[0]
    let y = normal[1]
    let z = normal[2]
    const angle = (rotation.angle || 0) * Math.PI / 180
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    if(rotation.axis === 'x'){
        const ny = y * cos - z * sin
        const nz = y * sin + z * cos
        y = ny
        z = nz
    } else if(rotation.axis === 'y'){
        const nx = x * cos - z * sin
        const nz = x * sin + z * cos
        x = nx
        z = nz
    } else if(rotation.axis === 'z'){
        const nx = x * cos - y * sin
        const ny = x * sin + y * cos
        x = nx
        y = ny
    }
    return [x, y, z]
}

function rotateNormal(normal, rotX, rotY){
    let x = normal[0]
    let y = normal[1]
    let z = normal[2]
    if(rotY){
        const rad = rotY * Math.PI / 180
        const cos = Math.cos(rad)
        const sin = Math.sin(rad)
        const nx = x * cos - z * sin
        const nz = x * sin + z * cos
        x = nx
        z = nz
    }
    if(rotX){
        const rad = rotX * Math.PI / 180
        const cos = Math.cos(rad)
        const sin = Math.sin(rad)
        const ny = y * cos - z * sin
        const nz = y * sin + z * cos
        y = ny
        z = nz
    }
    return [x, y, z]
}

function faceNameFromNormal(normal){
    const ax = Math.abs(normal[0])
    const ay = Math.abs(normal[1])
    const az = Math.abs(normal[2])
    if(ax >= ay && ax >= az){
        return normal[0] >= 0 ? 'east' : 'west'
    }
    if(ay >= ax && ay >= az){
        return normal[1] >= 0 ? 'up' : 'down'
    }
    return normal[2] >= 0 ? 'south' : 'north'
}

function buildQuadUvs(){
    return [
        [0, 1],
        [1, 1],
        [1, 0],
        [0, 1],
        [1, 0],
        [0, 0]
    ]
}

function applyAtlasUvs(quadUvs, atlasUv){
    if(!atlasUv || !quadUvs){
        return quadUvs
    }
    const [au0, av0, au1, av1] = atlasUv
    return quadUvs.map((uv) => [
        au0 + uv[0] * (au1 - au0),
        av0 + uv[1] * (av1 - av0)
    ])
}

function applyFaceUvs(quadUvs, faceUv){
    if(!faceUv || !quadUvs){
        return quadUvs
    }
    const [u0, v0, u1, v1] = faceUv
    return quadUvs.map((uv) => [
        u0 + uv[0] * (u1 - u0),
        v0 + uv[1] * (v1 - v0)
    ])
}

function normalizeFaceUv(uv, from, to, faceName){
    if(Array.isArray(uv) && uv.length === 4){
        return [uv[0] / 16, uv[1] / 16, uv[2] / 16, uv[3] / 16]
    }
    const fx = from[0] / 16
    const fy = from[1] / 16
    const fz = from[2] / 16
    const tx = to[0] / 16
    const ty = to[1] / 16
    const tz = to[2] / 16
    switch(faceName){
        case 'north':
        case 'south':
            return [fx, fy, tx, ty]
        case 'east':
        case 'west':
            return [fz, fy, tz, ty]
        case 'up':
        case 'down':
            return [fx, fz, tx, tz]
        default:
            return [fx, fy, tx, ty]
    }
}

function resolveTextureRef(model, textureRef){
    const textures = model?.textures || {}
    let ref = textureRef || textures.all || textures.texture || 'block/stone'
    let guard = 0
    while(typeof ref === 'string' && ref.startsWith('#') && guard < 6){
        const key = ref.slice(1)
        ref = textures[key] || textures.all || textures.texture || 'block/stone'
        guard += 1
    }
    if(typeof ref !== 'string'){
        return 'minecraft:block/stone'
    }
    if(ref.includes(':')){
        return ref
    }
    return `minecraft:${ref}`
}

function rotateQuadUvsInPlace(quadUvs, turns){
    if(!quadUvs || quadUvs.length !== 6){
        return
    }
    let count = turns % 4
    if(count < 0){
        count += 4
    }
    for(let i=0; i<count; i++){
        for(let t=0; t<quadUvs.length; t++){
            const uv = quadUvs[t]
            quadUvs[t] = [uv[1], 1 - uv[0]]
        }
    }
}

function normalizeFaceRotation(rotation){
    if(!Number.isFinite(rotation)){
        return 0
    }
    return ((Math.round(rotation / 90) % 4) + 4) % 4
}

function getUvlockTurns(rotX, rotY, faceName){
    const xTurns = Math.round(rotX / 90)
    const yTurns = Math.round(rotY / 90)
    if(faceName === 'up'){
        return -yTurns
    }
    if(faceName === 'down'){
        return yTurns
    }
    if(faceName === 'north'){
        return -yTurns
    }
    if(faceName === 'south'){
        return yTurns
    }
    if(faceName === 'east'){
        return -xTurns
    }
    if(faceName === 'west'){
        return xTurns
    }
    return 0
}

function collectTextureIdsForModel(model){
    const ids = new Set()
    const textures = model?.textures || {}
    const elements = Array.isArray(model?.elements) ? model.elements : DEFAULT_MODEL.elements
    for(const element of elements){
        if(element.faces){
            for(const face of Object.values(element.faces)){
                const textureId = resolveTextureRef(model, face?.texture)
                ids.add(textureId)
            }
        } else if(textures.all){
            ids.add(resolveTextureRef(model, textures.all))
        }
    }
    return ids
}

function collectTextureIdsForSchematic(schematic, registry){
    const ids = new Set()
    if(!schematic || !Array.isArray(schematic.palette)){
        return ids
    }
    for(const entry of schematic.palette){
        const blockId = entry?.block || 'minecraft:stone'
        const state = entry?.state
        const models = resolveBlockstateModels(blockId, state, registry)
        for(const modelEntry of models){
            const modelId = normalizeModelId(modelEntry.model || 'block/cube_all')
            const model = resolveModel(modelId, registry)
            collectTextureIdsForModel(model).forEach(id => ids.add(id))
        }
    }
    return ids
}

function matchVariantKey(state, key){
    if(!key || key === 'normal'){
        return true
    }
    if(!state){
        return false
    }
    const clauses = key.split(',').map(part => part.trim()).filter(Boolean)
    for(const clause of clauses){
        const [prop, value] = clause.split('=').map(s => s.trim())
        if(!prop){
            continue
        }
        const actual = String(state[prop] ?? '')
        const allowed = value.split('|').map(v => v.trim())
        if(!allowed.includes(actual)){
            return false
        }
    }
    return true
}

function matchWhen(state, when){
    if(!when){
        return true
    }
    if(Array.isArray(when)){
        return when.some((entry) => matchWhen(state, entry))
    }
    if(typeof when !== 'object'){
        return false
    }
    for(const [prop, value] of Object.entries(when)){
        const actual = String(state?.[prop] ?? '')
        const allowed = String(value).split('|').map(v => v.trim())
        if(!allowed.includes(actual)){
            return false
        }
    }
    return true
}

module.exports = {
    resolveBlockstateModels,
    resolveModel,
    buildBlockMesh,
    buildSchematicMesh,
    collectTextureIdsForSchematic
}
