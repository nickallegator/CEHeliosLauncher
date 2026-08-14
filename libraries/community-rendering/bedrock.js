'use strict'

function radians(value) { return (Number(value) || 0) * Math.PI / 180 }

function identity() {
    return [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
}

function multiply(left, right) {
    const out = new Array(12).fill(0)
    for(let row = 0; row < 3; row += 1) {
        for(let column = 0; column < 3; column += 1) {
            out[row * 3 + column] = left[row * 3] * right[column]
                + left[row * 3 + 1] * right[3 + column]
                + left[row * 3 + 2] * right[6 + column]
        }
        out[9 + row] = left[row * 3] * right[9]
            + left[row * 3 + 1] * right[10]
            + left[row * 3 + 2] * right[11]
            + left[9 + row]
    }
    return out
}

function translation(x, y, z) {
    const value = identity()
    value[9] = x; value[10] = y; value[11] = z
    return value
}

function rotation(x, y, z) {
    const cx = Math.cos(radians(x)); const sx = Math.sin(radians(x))
    const cy = Math.cos(radians(y)); const sy = Math.sin(radians(y))
    const cz = Math.cos(radians(z)); const sz = Math.sin(radians(z))
    const rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx, 0, 0, 0]
    const ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy, 0, 0, 0]
    const rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1, 0, 0, 0]
    return multiply(multiply(rz, ry), rx)
}

function pivotRotation(pivot, angles) {
    const [px, py, pz] = vector(pivot)
    const [rx, ry, rz] = vector(angles)
    return multiply(multiply(translation(px, py, pz), rotation(-rx, -ry, rz)), translation(-px, -py, -pz))
}

function transformPoint(matrix, point) {
    return [
        matrix[0] * point[0] + matrix[1] * point[1] + matrix[2] * point[2] + matrix[9],
        matrix[3] * point[0] + matrix[4] * point[1] + matrix[5] * point[2] + matrix[10],
        matrix[6] * point[0] + matrix[7] * point[1] + matrix[8] * point[2] + matrix[11]
    ]
}

function transformNormal(matrix, normal) {
    const value = [
        matrix[0] * normal[0] + matrix[1] * normal[1] + matrix[2] * normal[2],
        matrix[3] * normal[0] + matrix[4] * normal[1] + matrix[5] * normal[2],
        matrix[6] * normal[0] + matrix[7] * normal[1] + matrix[8] * normal[2]
    ]
    const length = Math.hypot(...value) || 1
    return value.map(component => component / length)
}

function vector(value, fallback = [0, 0, 0]) {
    return Array.isArray(value) ? [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0] : fallback.slice()
}

function parseBedrockGeometry(document, options = {}) {
    const geometries = Array.isArray(document?.['minecraft:geometry']) ? document['minecraft:geometry'] : []
    if(!geometries.length) throw formatError('missing_geometry', 'Bedrock model contains no minecraft:geometry definitions.')
    const requested = String(options.identifier || '')
    const geometry = (requested && geometries.find(value => value?.description?.identifier === requested)) || geometries[0]
    const description = geometry?.description || {}
    const textureWidth = positive(description.texture_width, 64)
    const textureHeight = positive(description.texture_height, 64)
    const bones = Array.isArray(geometry?.bones) ? geometry.bones : []
    if(bones.length > 1024) throw formatError('bedrock_bone_limit', 'Bedrock model exceeds 1,024 bones.')
    const byName = new Map()
    for(const source of bones) {
        const name = String(source?.name || '')
        if(!name || byName.has(name)) throw formatError('invalid_bedrock_bone', 'Bedrock bone names must be non-empty and unique.')
        byName.set(name, { source, matrix: null, resolving: false })
    }
    function matrixFor(name) {
        const entry = byName.get(name)
        if(!entry) return identity()
        if(entry.matrix) return entry.matrix
        if(entry.resolving) throw formatError('bedrock_bone_cycle', 'Bedrock model contains a parent cycle.')
        entry.resolving = true
        const parent = entry.source.parent ? matrixFor(String(entry.source.parent)) : identity()
        entry.matrix = multiply(parent, pivotRotation(entry.source.pivot, entry.source.rotation))
        entry.resolving = false
        return entry.matrix
    }

    const positions = []
    const normals = []
    const uvs = []
    let cubeCount = 0
    for(const [name, entry] of byName) {
        const boneMatrix = matrixFor(name)
        const cubes = Array.isArray(entry.source.cubes) ? entry.source.cubes : []
        cubeCount += cubes.length
        if(cubeCount > 16384) throw formatError('bedrock_cube_limit', 'Bedrock model exceeds 16,384 cubes.')
        for(const cube of cubes) appendCube({ positions, normals, uvs }, cube, boneMatrix, textureWidth, textureHeight)
    }
    if(positions.length === 0) throw formatError('empty_bedrock_geometry', 'Bedrock model has no renderable cubes.')
    const bounds = boundsFor(positions)
    const center = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2]
    for(let index = 0; index < positions.length; index += 3) {
        positions[index] = (positions[index] - center[0]) / 16
        positions[index + 1] = (positions[index + 1] - center[1]) / 16
        positions[index + 2] = (positions[index + 2] - center[2]) / 16
    }
    const normalizedBounds = boundsFor(positions)
    return {
        identifier: String(description.identifier || ''),
        textureWidth,
        textureHeight,
        cubeCount,
        boneCount: bones.length,
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        uvs: new Float32Array(uvs),
        bounds: normalizedBounds
    }
}

const FACES = Object.freeze([
    { name: 'north', normal: [0, 0, -1], points: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
    { name: 'south', normal: [0, 0, 1], points: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
    { name: 'west', normal: [-1, 0, 0], points: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
    { name: 'east', normal: [1, 0, 0], points: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
    { name: 'up', normal: [0, 1, 0], points: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
    { name: 'down', normal: [0, -1, 0], points: [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]] }
])

function appendCube(target, cube, boneMatrix, textureWidth, textureHeight) {
    const origin = vector(cube.origin)
    const size = vector(cube.size)
    const inflate = Number(cube.inflate) || 0
    const from = origin.map(value => value - inflate)
    const to = origin.map((value, index) => value + size[index] + inflate)
    const cubeMatrix = multiply(boneMatrix, pivotRotation(cube.pivot || origin, cube.rotation))
    const faceUvs = resolveCubeUvs(cube, size, textureWidth, textureHeight)
    for(const face of FACES) {
        const definition = faceUvs[face.name]
        if(definition === null) continue
        const points = face.points.map(point => transformPoint(cubeMatrix, [
            point[0] ? to[0] : from[0], point[1] ? to[1] : from[1], point[2] ? to[2] : from[2]
        ]))
        const normal = transformNormal(cubeMatrix, face.normal)
        const quadUvs = definition || [[0, 1], [0, 0], [1, 0], [1, 1]]
        const order = cube.mirror ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]
        for(const index of order) {
            target.positions.push(...points[index])
            target.normals.push(...normal)
            target.uvs.push(...quadUvs[index])
        }
    }
}

function resolveCubeUvs(cube, size, textureWidth, textureHeight) {
    if(cube.uv && !Array.isArray(cube.uv) && typeof cube.uv === 'object') {
        return Object.fromEntries(FACES.map(face => {
            const definition = cube.uv[face.name]
            if(definition == null) return [face.name, null]
            const uv = Array.isArray(definition.uv) ? definition.uv : [0, 0]
            const dimensions = Array.isArray(definition.uv_size) ? definition.uv_size : faceSize(face.name, size)
            return [face.name, normalizedUv(uv[0], uv[1], dimensions[0], dimensions[1], textureWidth, textureHeight)]
        }))
    }
    const [u, v] = Array.isArray(cube.uv) ? cube.uv.map(Number) : [0, 0]
    const [width, height, depth] = size
    return {
        west: normalizedUv(u, v + depth, depth, height, textureWidth, textureHeight),
        north: normalizedUv(u + depth, v + depth, width, height, textureWidth, textureHeight),
        east: normalizedUv(u + depth + width, v + depth, depth, height, textureWidth, textureHeight),
        south: normalizedUv(u + depth + width + depth, v + depth, width, height, textureWidth, textureHeight),
        up: normalizedUv(u + depth, v, width, depth, textureWidth, textureHeight),
        down: normalizedUv(u + depth + width, v, width, depth, textureWidth, textureHeight)
    }
}

function faceSize(face, size) {
    if(['north', 'south'].includes(face)) return [size[0], size[1]]
    if(['west', 'east'].includes(face)) return [size[2], size[1]]
    return [size[0], size[2]]
}

function normalizedUv(u, v, width, height, textureWidth, textureHeight) {
    const left = Number(u) / textureWidth
    const top = Number(v) / textureHeight
    const right = (Number(u) + Number(width)) / textureWidth
    const bottom = (Number(v) + Number(height)) / textureHeight
    return [[left, bottom], [left, top], [right, top], [right, bottom]]
}

function boundsFor(positions) {
    const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
    const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
    for(let index = 0; index < positions.length; index += 3) {
        for(let axis = 0; axis < 3; axis += 1) {
            min[axis] = Math.min(min[axis], positions[index + axis])
            max[axis] = Math.max(max[axis], positions[index + axis])
        }
    }
    return { min, max, size: max.map((value, axis) => value - min[axis]) }
}

function positive(value, fallback) {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? number : fallback
}

function formatError(code, message) {
    return Object.assign(new Error(message), { code })
}

function selectResolverVariation(resolvers, aspects = []) {
    const required = new Set((aspects || []).map(value => String(value).toLowerCase()))
    const candidates = (Array.isArray(resolvers) ? resolvers : [resolvers])
        .filter(Boolean)
        .flatMap(document => (Array.isArray(document.variations) ? document.variations : []).map(variation => ({
            ...variation,
            order: Number(document.order || 0),
            aspects: (Array.isArray(variation.aspects) ? variation.aspects : []).map(value => String(value).toLowerCase())
        })))
        .filter(variation => variation.aspects.every(aspect => required.has(aspect)))
        .sort((left, right) => left.order - right.order || left.aspects.length - right.aspects.length)
    const resolved = {}
    for(const variation of candidates) {
        for(const key of ['model', 'texture', 'poser', 'layers']) {
            if(variation[key] != null) resolved[key] = variation[key]
        }
    }
    return Object.keys(resolved).length ? resolved : null
}

module.exports = {
    boundsFor,
    parseBedrockGeometry,
    selectResolverVariation,
    transformNormal,
    transformPoint
}
