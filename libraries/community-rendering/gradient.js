'use strict'

const GRADIENT_TYPES = Object.freeze(['SMOOTH', 'BANDS', 'NEAREST'])
const LEGACY_GRADIENT_TYPES = new Set(['LINEAR', 'RADIAL', 'ANGULAR'])
const PREVIEW_MIN_CELLS = 4
const PREVIEW_MAX_CELLS = 64
const PREVIEW_DEFAULT_CELLS = 16
const BAND_STEPS = 8
const MIN_NODE_FALLOFF = 0.06
const FALLOFF_SOFTNESS_MIN = 0.02
const FALLOFF_SOFTNESS_MAX = 0.35

function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, Number(value) || 0))
}

function lerp(amount, start, end) {
    return start + amount * (end - start)
}

function normalizeGradientType(value) {
    const requested = String(value || 'SMOOTH').trim().toUpperCase()
    if(GRADIENT_TYPES.includes(requested)) return { type: requested, legacyFallback: false, requested }
    if(LEGACY_GRADIENT_TYPES.has(requested)) return { type: 'SMOOTH', legacyFallback: true, requested }
    return { type: 'SMOOTH', legacyFallback: requested !== 'SMOOTH', requested }
}

function parseGradientDocument(input = {}) {
    if(input == null) return {}
    if(typeof input === 'string') return JSON.parse(input)
    if(Buffer.isBuffer(input)) return JSON.parse(input.toString('utf8'))
    if(input instanceof ArrayBuffer) return JSON.parse(Buffer.from(input).toString('utf8'))
    if(ArrayBuffer.isView(input)) {
        return JSON.parse(Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString('utf8'))
    }
    if(typeof input !== 'object') throw new TypeError('Gradient document must be JSON or a binary JSON artifact.')
    return input
}

function normalizeGradientDocument(input = {}) {
    const root = parseGradientDocument(input)
    const type = normalizeGradientType(root.settings?.type)
    return {
        type,
        nodes: (Array.isArray(root.nodes) ? root.nodes : []).map((node, index) => ({
            id: Number.isInteger(Number(node.id)) ? Number(node.id) : index + 1,
            x: clamp(node.x),
            y: clamp(node.y),
            value: clamp(node.value),
            falloff: clamp(node.falloff == null ? 0.25 : node.falloff),
            strength: clamp(node.strength == null ? 1 : node.strength),
            shapeNodes: (Array.isArray(node.shape_nodes) ? node.shape_nodes : []).map((shape, shapeIndex) => ({
                id: Number.isInteger(Number(shape.id)) ? Number(shape.id) : shapeIndex + 1,
                parentId: Number.isInteger(Number(shape.parent_id)) ? Number(shape.parent_id) : -1,
                x: clamp(shape.x),
                y: clamp(shape.y),
                falloff: clamp(shape.falloff == null ? 0.25 : shape.falloff),
                strength: clamp(shape.strength == null ? 1 : shape.strength)
            }))
        })),
        pins: (Array.isArray(root.pins) ? root.pins : [])
            .filter(pin => pin && typeof pin.block === 'string' && pin.block)
            .map(pin => ({ value: clamp(pin.value), block: String(pin.block) }))
            .sort((left, right) => left.value - right.value || left.block.localeCompare(right.block)),
        noiseEnabled: Boolean(root.settings?.noise),
        noiseStrength: clamp(root.settings?.noise_strength == null ? 1 : root.settings.noise_strength, 0, 3),
        blendEnabled: Boolean(root.blend?.enabled),
        blendSharpness: clamp(root.blend?.sharpness == null ? 0.5 : root.blend.sharpness),
        blendRadius: clamp(root.blend?.radius == null ? 0.25 : root.blend.radius),
        blendSeed: BigInt(Number.isSafeInteger(Number(root.blend?.seed)) ? Number(root.blend.seed) : 0),
        previewCells: clampCells(root.preview?.grid_cells)
    }
}

function clampCells(value) {
    const number = Number.isFinite(Number(value)) ? Math.round(Number(value)) : PREVIEW_DEFAULT_CELLS
    return Math.max(PREVIEW_MIN_CELLS, Math.min(PREVIEW_MAX_CELLS, number))
}

class GradientEvaluator {
    constructor(document, scale = null) {
        this.model = document?.nodes && document?.type?.type ? document : normalizeGradientDocument(document)
        this.scale = clampCells(scale == null ? this.model.previewCells : scale)
        this.minFalloff = Math.max(1 / this.scale, MIN_NODE_FALLOFF)
    }

    evaluate(x, y) {
        const px = clamp(x)
        const py = clamp(y)
        if(this.model.nodes.length === 0) return px
        const base = this.model.type.type === 'NEAREST'
            ? this.evaluateNearestValue(px, py)
            : this.evaluateWeightedValue(px, py)
        if(this.model.type.type === 'BANDS') return quantize(this.applyNoise(base, px, py, true), BAND_STEPS)
        if(this.model.type.type === 'SMOOTH') return this.applyNoise(base, px, py, false)
        return base
    }

    resolveBlock(value, sampleX, sampleY) {
        const pins = this.model.pins
        if(pins.length === 0) return null
        if(!this.model.blendEnabled || this.model.blendRadius <= 0.0001) return nearestPin(pins, value)
        const exponent = lerp(this.model.blendSharpness, 0.5, 4)
        const weights = new Float64Array(pins.length)
        let total = 0
        for(let index = 0; index < pins.length; index += 1) {
            const difference = Math.abs(pins[index].value - value)
            if(difference > this.model.blendRadius) continue
            const weight = Math.pow(clamp(1 - difference / this.model.blendRadius), exponent)
            weights[index] = weight
            total += weight
        }
        if(total <= 0.0001) return nearestPin(pins, value)
        const target = hashToUnitFloat(this.model.blendSeed, sampleX, sampleY) * total
        let accumulated = 0
        for(let index = 0; index < pins.length; index += 1) {
            accumulated += weights[index]
            if(weights[index] > 0 && target <= accumulated) return pins[index].block
        }
        return nearestPin(pins, value)
    }

    evaluateWeightedValue(x, y) {
        const distances = new Float64Array(this.model.nodes.length)
        const strengths = new Float64Array(this.model.nodes.length)
        let anyValid = false
        for(let index = 0; index < this.model.nodes.length; index += 1) {
            const result = this.effectiveDistance(this.model.nodes[index], x, y)
            distances[index] = result.distance
            strengths[index] = result.strength
            anyValid ||= result.strength > 0.0001 && Number.isFinite(result.distance)
        }
        if(!anyValid) return 0
        let total = 0
        let weightSum = 0
        for(let index = 0; index < this.model.nodes.length; index += 1) {
            const distance = distances[index]
            const strength = strengths[index]
            if(strength <= 0.0001 || !Number.isFinite(distance)) continue
            const softness = lerp(strength, FALLOFF_SOFTNESS_MAX, FALLOFF_SOFTNESS_MIN)
            const gate = distance <= 1 ? 1 : smoothstep(1 + softness, 1, distance)
            if(gate <= 0.0001) continue
            const weight = (1 / (distance * distance + 0.0001)) * gate * strength
            total += this.model.nodes[index].value * weight
            weightSum += weight
        }
        return weightSum <= 0 ? 0 : clamp(total / weightSum)
    }

    evaluateNearestValue(x, y) {
        let bestDistance = Number.POSITIVE_INFINITY
        let bestValue = x
        for(const node of this.model.nodes) {
            const result = this.effectiveDistance(node, x, y)
            if(result.strength > 0.0001 && result.distance < bestDistance) {
                bestDistance = result.distance
                bestValue = node.value
            }
        }
        return clamp(bestValue)
    }

    effectiveDistance(node, x, y) {
        if(node.shapeNodes.length > 0) {
            let best = Number.POSITIVE_INFINITY
            let bestStrength = 0
            for(const shape of node.shapeNodes) {
                const parent = shape.parentId < 0 ? null : node.shapeNodes.find(value => value.id === shape.parentId)
                const ax = parent ? parent.x : node.x
                const ay = parent ? parent.y : node.y
                const parentFalloff = Math.max(this.minFalloff, parent ? parent.falloff : node.falloff)
                const parentStrength = clamp(parent ? parent.strength : node.strength)
                const segment = distanceToSegment(x, y, ax, ay, shape.x, shape.y)
                const falloff = lerp(segment.t, parentFalloff, Math.max(this.minFalloff, shape.falloff))
                const strength = lerp(segment.t, parentStrength, clamp(shape.strength))
                if(strength <= 0.0001) continue
                const ratio = segment.distance / Math.max(0.0001, falloff)
                if(ratio < best) {
                    best = ratio
                    bestStrength = strength
                }
            }
            if(Number.isFinite(best)) return { distance: best, strength: bestStrength }
        }
        const dx = x - node.x
        const dy = y - node.y
        const falloff = Math.max(this.minFalloff, node.falloff)
        return { distance: Math.sqrt((dx * dx + dy * dy) / Math.max(0.000001, falloff * falloff) + 0.000001), strength: clamp(node.strength) }
    }

    applyNoise(value, x, y, stronger) {
        if(!this.model.noiseEnabled) return value
        const strength = (stronger ? 0.08 : 0.04) * this.model.noiseStrength
        return clamp(value + (hashNoise(x, y) - 0.5) * strength)
    }
}

function distanceToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax
    const dy = by - ay
    const lengthSquared = dx * dx + dy * dy
    if(lengthSquared <= 0.000001) return { distance: Math.hypot(px - ax, py - ay), t: 0 }
    const t = clamp(((px - ax) * dx + (py - ay) * dy) / lengthSquared)
    return { distance: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t }
}

function hashNoise(x, y) {
    const ix = Math.round(x * 1024)
    const iy = Math.round(y * 1024)
    let hash = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263)) | 0
    hash = Math.imul(hash ^ (hash >> 13), 1274126177)
    hash ^= hash >> 16
    return (hash & 0xFFFF) / 65535
}

function hashToUnitFloat(seed, x, y) {
    const mask = (1n << 64n) - 1n
    let hash = BigInt.asUintN(64, BigInt(seed))
    hash ^= BigInt.asUintN(64, BigInt(Math.trunc(x)) * 0x9E3779B97F4A7C15n)
    hash ^= BigInt.asUintN(64, BigInt(Math.trunc(y)) * 0xC2B2AE3D27D4EB4Fn)
    hash ^= hash >> 33n
    hash = (hash * 0xFF51AFD7ED558CCDn) & mask
    hash ^= hash >> 33n
    hash = (hash * 0xC4CEB9FE1A85EC53n) & mask
    hash ^= hash >> 33n
    return Number(hash & 0xFFFFFFn) / 0x1000000
}

function smoothstep(edge0, edge1, value) {
    const amount = clamp((value - edge0) / (edge1 - edge0))
    return amount * amount * (3 - 2 * amount)
}

function quantize(value, steps) {
    return steps <= 1 ? clamp(value) : Math.round(clamp(value) * (steps - 1)) / (steps - 1)
}

function nearestPin(pins, value) {
    let selected = null
    let difference = Number.POSITIVE_INFINITY
    for(const pin of pins) {
        const next = Math.abs(pin.value - value)
        if(next < difference) {
            difference = next
            selected = pin.block
        }
    }
    return selected
}

function sampleGradient(document, scale = null) {
    const evaluator = new GradientEvaluator(document, scale)
    const cells = evaluator.scale
    const values = new Float32Array(cells * cells)
    const blocks = new Array(cells * cells)
    for(let y = 0; y < cells; y += 1) {
        for(let x = 0; x < cells; x += 1) {
            const index = y * cells + x
            const value = evaluator.evaluate((x + 0.5) / cells, (y + 0.5) / cells)
            values[index] = value
            blocks[index] = evaluator.resolveBlock(value, x, y)
        }
    }
    return { cells, values, blocks, model: evaluator.model }
}

module.exports = {
    BAND_STEPS,
    FALLOFF_SOFTNESS_MAX,
    FALLOFF_SOFTNESS_MIN,
    GRADIENT_TYPES,
    GradientEvaluator,
    LEGACY_GRADIENT_TYPES,
    MIN_NODE_FALLOFF,
    PREVIEW_DEFAULT_CELLS,
    PREVIEW_MAX_CELLS,
    PREVIEW_MIN_CELLS,
    clampCells,
    hashNoise,
    hashToUnitFloat,
    normalizeGradientDocument,
    normalizeGradientType,
    parseGradientDocument,
    sampleGradient
}
