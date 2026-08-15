'use strict'

const DEFAULT_EXPRESSION_LOOP_SECONDS = 4
const MAX_EXPRESSION_LENGTH = 512

function displayName(id) {
    return String(id || '').split('.').at(-1).replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase())
}

function shortAnimationId(id) {
    const parts = String(id || '').split('.')
    return parts.at(-1) || String(id || '')
}

function tokenize(source) {
    if(source.length > MAX_EXPRESSION_LENGTH) throw new Error('Bedrock animation expression is too long.')
    const tokens = []
    const expression = source.trim()
    let index = 0
    while(index < expression.length) {
        const rest = expression.slice(index)
        const whitespace = rest.match(/^\s+/)
        if(whitespace) { index += whitespace[0].length; continue }
        const number = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i)
        if(number) { tokens.push({ type: 'number', value: Number(number[0]) }); index += number[0].length; continue }
        const identifier = rest.match(/^[a-z_][a-z0-9_.]*/i)
        if(identifier) { tokens.push({ type: 'identifier', value: identifier[0].toLowerCase() }); index += identifier[0].length; continue }
        const operator = rest[0]
        if('+-*/%(),'.includes(operator)) { tokens.push({ type: operator, value: operator }); index += 1; continue }
        throw new Error(`Unsupported Bedrock animation expression token "${operator}".`)
    }
    return tokens
}

const FUNCTIONS = Object.freeze({
    'math.sin': value => Math.sin(Number(value) * Math.PI / 180),
    'math.cos': value => Math.cos(Number(value) * Math.PI / 180),
    'math.abs': Math.abs,
    'math.floor': Math.floor,
    'math.ceil': Math.ceil,
    'math.round': Math.round,
    'math.sqrt': value => Math.sqrt(Math.max(0, Number(value))),
    'math.min': Math.min,
    'math.max': Math.max,
    'math.pow': Math.pow,
    'math.clamp': (value, minimum, maximum) => Math.max(Number(minimum), Math.min(Number(maximum), Number(value)))
})

function compileExpression(value) {
    if(typeof value === 'number') return () => Number.isFinite(value) ? value : 0
    if(typeof value !== 'string') return () => 0
    const tokens = tokenize(value)
    let cursor = 0
    const peek = type => tokens[cursor]?.type === type
    const consume = type => {
        if(!peek(type)) throw new Error(`Expected "${type}" in Bedrock animation expression.`)
        return tokens[cursor++]
    }
    function primary() {
        if(peek('number')) { const number = consume('number').value; return () => number }
        if(peek('(')) { consume('('); const expression = additive(); consume(')'); return expression }
        if(peek('identifier')) {
            const name = consume('identifier').value
            if(peek('(')) {
                consume('(')
                const parameters = []
                if(!peek(')')) {
                    parameters.push(additive())
                    while(peek(',')) { consume(','); parameters.push(additive()) }
                }
                consume(')')
                const fn = FUNCTIONS[name]
                if(!fn) return () => 0
                return context => {
                    const result = fn(...parameters.map(parameter => parameter(context)))
                    return Number.isFinite(result) ? result : 0
                }
            }
            if(['q.anim_time', 'query.anim_time'].includes(name)) return context => context.animTime
            if(name === 'math.pi') return () => Math.PI
            return () => 0
        }
        throw new Error('Invalid Bedrock animation expression.')
    }
    function unary() {
        if(peek('+')) { consume('+'); return unary() }
        if(peek('-')) { consume('-'); const operand = unary(); return context => -operand(context) }
        return primary()
    }
    function multiplicative() {
        let left = unary()
        while(peek('*') || peek('/') || peek('%')) {
            const operator = tokens[cursor++].type; const right = unary(); const previous = left
            left = context => {
                const a = previous(context); const b = right(context)
                if(operator === '*') return a * b
                if(operator === '/') return b === 0 ? 0 : a / b
                return b === 0 ? 0 : a % b
            }
        }
        return left
    }
    function additive() {
        let left = multiplicative()
        while(peek('+') || peek('-')) {
            const operator = tokens[cursor++].type; const right = multiplicative(); const previous = left
            left = context => operator === '+' ? previous(context) + right(context) : previous(context) - right(context)
        }
        return left
    }
    const compiled = additive()
    if(cursor !== tokens.length) throw new Error('Unexpected Bedrock animation expression input.')
    return context => {
        const result = compiled(context)
        return Number.isFinite(result) ? result : 0
    }
}

function vectorCompiler(value, fallback = 0) {
    const values = Array.isArray(value) ? value : [value, value, value]
    const compiled = [0, 1, 2].map(index => compileExpression(values[index] ?? fallback))
    return context => compiled.map(component => component(context))
}

function keyframeValue(value, side) {
    if(value && typeof value === 'object' && !Array.isArray(value)) {
        const fallback = side === 'pre' ? value.post : value.pre
        return value[side] ?? fallback ?? [0, 0, 0]
    }
    return value
}

function catmullRom(a, b, c, d, amount) {
    const squared = amount * amount; const cubed = squared * amount
    return .5 * ((2 * b) + (-a + c) * amount + (2 * a - 5 * b + 4 * c - d) * squared + (-a + 3 * b - 3 * c + d) * cubed)
}

function channelCompiler(value, fallback = 0) {
    if(Array.isArray(value) || typeof value === 'number' || typeof value === 'string') return vectorCompiler(value, fallback)
    if(!value || typeof value !== 'object') return vectorCompiler([fallback, fallback, fallback], fallback)
    const frames = Object.entries(value)
        .map(([time, frame]) => ({
            time: Number(time),
            pre: vectorCompiler(keyframeValue(frame, 'pre'), fallback),
            post: vectorCompiler(keyframeValue(frame, 'post'), fallback),
            interpolation: String(frame?.lerp_mode || '').toLowerCase()
        }))
        .filter(frame => Number.isFinite(frame.time))
        .sort((left, right) => left.time - right.time)
    if(!frames.length) return vectorCompiler([fallback, fallback, fallback], fallback)
    return context => {
        if(context.animTime <= frames[0].time) return frames[0].post(context)
        if(context.animTime >= frames.at(-1).time) return frames.at(-1).post(context)
        const exact = frames.find(frame => frame.time === context.animTime)
        if(exact) return exact.post(context)
        const upperIndex = frames.findIndex(frame => frame.time > context.animTime)
        const lowerIndex = Math.max(0, upperIndex - 1)
        const lower = frames[lowerIndex]; const upper = frames[upperIndex]
        const amount = (context.animTime - lower.time) / Math.max(.000001, upper.time - lower.time)
        const left = lower.post(context); const right = upper.pre(context)
        if(lower.interpolation === 'catmullrom' || upper.interpolation === 'catmullrom') {
            const before = lowerIndex > 0 ? frames[lowerIndex - 1].post(context) : left
            const after = upperIndex < frames.length - 1 ? frames[upperIndex + 1].pre(context) : right
            return left.map((component, axis) => catmullRom(before[axis], component, right[axis], after[axis], amount))
        }
        return left.map((component, axis) => component + (right[axis] - component) * amount)
    }
}

function inferredLength(animation) {
    const explicit = Number(animation?.animation_length)
    if(Number.isFinite(explicit) && explicit > 0) return explicit
    let maximum = 0
    for(const bone of Object.values(animation?.bones || {})) {
        for(const channel of ['rotation', 'position', 'scale']) {
            const value = bone?.[channel]
            if(!value || Array.isArray(value) || typeof value !== 'object') continue
            for(const time of Object.keys(value)) if(Number.isFinite(Number(time))) maximum = Math.max(maximum, Number(time))
        }
    }
    return maximum || DEFAULT_EXPRESSION_LOOP_SECONDS
}

function bedrockAnimationIdentity(value) {
    const sourceId = String(value || '').trim()
    const segments = sourceId.replace(/^animation\./i, '').split('.').filter(Boolean)
    const id = segments.pop() || sourceId
    return {
        sourceId,
        group: segments.join('.'),
        id
    }
}

function compileAnimation(id, animation) {
    const identity = bedrockAnimationIdentity(id)
    const bones = Object.fromEntries(Object.entries(animation?.bones || {}).map(([name, bone]) => [name, {
        rotation: channelCompiler(bone?.rotation, 0),
        position: channelCompiler(bone?.position, 0),
        scale: channelCompiler(bone?.scale, 1),
        hasRotation: bone?.rotation != null,
        hasPosition: bone?.position != null,
        hasScale: bone?.scale != null
    }]))
    return {
        id: identity.id,
        group: identity.group,
        sourceId: identity.sourceId,
        label: displayName(identity.id),
        loop: animation?.loop === true,
        length: inferredLength(animation),
        sample(timeSeconds) {
            const length = this.length
            const animTime = this.loop ? ((Math.max(0, timeSeconds) % length) + length) % length : Math.min(length, Math.max(0, timeSeconds))
            const context = { animTime }
            return { bones: Object.fromEntries(Object.entries(bones).map(([name, bone]) => {
                const result = {}
                if(bone.hasRotation) result.rotation = bone.rotation(context)
                if(bone.hasPosition) result.position = bone.position(context)
                if(bone.hasScale) result.scale = bone.scale(context)
                return [name, result]
            })) }
        }
    }
}

function compileBedrockAnimations(documents) {
    const values = new Map()
    for(const document of documents || []) {
        for(const [id, animation] of Object.entries(document?.animations || {}).sort(([left], [right]) => left.localeCompare(right))) {
            if(!animation?.bones || typeof animation.bones !== 'object') continue
            // Several forms can share a resource folder and reuse short names
            // such as `ground_idle`. Cobblemon addresses them by the complete
            // animation ID, so retaining only the final segment would silently
            // pose one form with another form's clip.
            try { values.set(String(id).toLowerCase(), compileAnimation(id, animation)) } catch { /* Unsupported expressions do not disable other animations. */ }
        }
    }
    return [...values.values()].sort((left, right) => left.label.localeCompare(right.label)
        || left.group.localeCompare(right.group)
        || left.id.localeCompare(right.id))
}

function poserAnimationReferences(poser, posePreference = ['STAND', 'NONE', 'PORTRAIT', 'PROFILE']) {
    const poses = Object.entries(poser?.poses || {})
    const ranked = poses.sort(([, left], [, right]) => {
        const rank = pose => Math.min(...(posePreference || []).map((type, index) => (pose?.poseTypes || []).includes(type) ? index : 999))
        return Number(Boolean(left?.isBattle)) - Number(Boolean(right?.isBattle)) || rank(left) - rank(right)
    })
    const references = []
    const seen = new Set()
    for(const [, pose] of ranked) {
        for(const expression of pose?.animations || []) {
            const match = String(expression).match(/q\.bedrock\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/i)
            if(!match) continue
            const reference = { group: match[1], id: match[2] }
            const key = `${reference.group.toLowerCase()}:${reference.id.toLowerCase()}`
            if(!seen.has(key)) { seen.add(key); references.push(reference) }
        }
    }
    return references
}

function poserAnimationIds(poser, posePreference = ['STAND', 'NONE', 'PORTRAIT', 'PROFILE']) {
    const ids = []
    for(const reference of poserAnimationReferences(poser, posePreference)) {
        if(!ids.includes(reference.id)) ids.push(reference.id)
    }
    return ids
}

function findReferencedAnimation(values, reference) {
    const group = String(reference?.group || '').toLowerCase()
    const id = String(reference?.id || '').toLowerCase()
    const exact = values.find(animation => animation.group.toLowerCase() === group && animation.id.toLowerCase() === id)
    if(exact) return exact
    const shortMatches = values.filter(animation => animation.id.toLowerCase() === id)
    return shortMatches.length === 1 ? shortMatches[0] : null
}

function scopedBedrockAnimations(animations, poser) {
    const values = animations || []
    const groups = new Set(poserAnimationReferences(poser).map(reference => reference.group.toLowerCase()))
    if(groups.size === 0) return values
    const scoped = values.filter(animation => groups.has(animation.group.toLowerCase()))
    return scoped.length ? scoped : values
}

function selectDefaultBedrockAnimation(animations, poser) {
    const values = animations || []
    for(const reference of poserAnimationReferences(poser)) {
        const animation = findReferencedAnimation(values, reference)
        if(animation) return animation
    }
    const scoped = scopedBedrockAnimations(values, poser)
    const priorities = ['ground_idle', 'idle', 'standing']
    for(const id of priorities) {
        const animation = scoped.find(value => value.id.toLowerCase() === id)
        if(animation) return animation
    }
    return scoped.find(animation => animation.id.toLowerCase().includes('idle') && !animation.id.toLowerCase().includes('_size'))
        || scoped.find(animation => animation.id.toLowerCase() === 'pose')
        || scoped[0]
        || null
}

function selectStaticBedrockAnimation(animations, poser) {
    const scoped = scopedBedrockAnimations(animations || [], poser)
    return scoped.find(animation => animation.id.toLowerCase() === 'render')
        || scoped.find(animation => animation.id.toLowerCase() === 'pose')
        || null
}

function composeBedrockPoses(basePose, overlayPose) {
    const baseBones = basePose?.bones || {}
    const overlayBones = overlayPose?.bones || {}
    const names = new Set([...Object.keys(baseBones), ...Object.keys(overlayBones)])
    const bones = {}
    const combine = (left, right, operation, identity) => [0, 1, 2].map(index => operation(
        Number(left?.[index] ?? identity),
        Number(right?.[index] ?? identity)
    ))
    for(const name of names) {
        const base = baseBones[name] || {}
        const overlay = overlayBones[name] || {}
        const bone = {}
        if(base.rotation || overlay.rotation) bone.rotation = combine(base.rotation, overlay.rotation, (left, right) => left + right, 0)
        if(base.position || overlay.position) bone.position = combine(base.position, overlay.position, (left, right) => left + right, 0)
        if(base.scale || overlay.scale) bone.scale = combine(base.scale, overlay.scale, (left, right) => left * right, 1)
        bones[name] = bone
    }
    return { bones }
}

function selectableBedrockAnimations(animations, poser) {
    const values = animations || []
    const scoped = scopedBedrockAnimations(values, poser)
    const result = []
    for(const reference of poserAnimationReferences(poser)) {
        const animation = findReferencedAnimation(scoped, reference)
        if(animation && !result.includes(animation)) result.push(animation)
    }
    for(const animation of scoped) {
        const id = animation.id.toLowerCase()
        if(result.includes(animation) || id === 'pose' || id === 'render' || id.endsWith('_size')) continue
        result.push(animation)
    }
    return result.length ? result : scoped
}

module.exports = {
    bedrockAnimationIdentity,
    compileBedrockAnimations,
    compileExpression,
    composeBedrockPoses,
    poserAnimationIds,
    poserAnimationReferences,
    scopedBedrockAnimations,
    selectableBedrockAnimations,
    selectDefaultBedrockAnimation,
    selectStaticBedrockAnimation,
    shortAnimationId
}
