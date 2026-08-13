'use strict'

const crypto = require('crypto')

const bundledKeyDocument = require('../../config/minecraft-auth-keys.json')

const EXPECTED_ALGORITHM = 'RS256'
const EXPECTED_ISSUER = 'authentication'
const DEFAULT_CLOCK_SKEW_SECONDS = 60
const MAX_TOKEN_LENGTH = 4096
const MAX_TOKEN_LIFETIME_SECONDS = 48 * 60 * 60
const UUID_PATTERN = /^[a-f0-9]{32}$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

class MinecraftTokenVerificationError extends Error {
    constructor(code, message) {
        super(message)
        this.name = 'MinecraftTokenVerificationError'
        this.code = code
    }
}

function reject(code, message) {
    throw new MinecraftTokenVerificationError(code, message)
}

function decodeJsonSegment(segment, label) {
    if(typeof segment !== 'string' || !BASE64URL_PATTERN.test(segment)) {
        reject('malformed_token', `Minecraft token ${label} is not valid base64url.`)
    }
    let parsed
    try {
        parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
    } catch(_err) {
        reject('malformed_token', `Minecraft token ${label} is not valid JSON.`)
    }
    if(parsed == null || Array.isArray(parsed) || typeof parsed !== 'object') {
        reject('malformed_token', `Minecraft token ${label} must be an object.`)
    }
    return parsed
}

function normalizeMinecraftUuid(value) {
    const normalized = String(value || '').trim().toLowerCase().replace(/-/g, '')
    if(!UUID_PATTERN.test(normalized)) {
        reject('invalid_profile', 'Minecraft token does not contain a valid profile UUID.')
    }
    return normalized
}

function parseKeyDocument(document) {
    if(document == null || Array.isArray(document) || typeof document !== 'object') {
        throw new Error('Minecraft authentication key document must be an object.')
    }
    const values = document.authenticationKeys
    if(!Array.isArray(values) || values.length === 0 || values.length > 8) {
        throw new Error('Minecraft authentication key document must contain between 1 and 8 keys.')
    }
    return values.map((entry, index) => {
        const encoded = typeof entry === 'string' ? entry : entry?.publicKey
        if(typeof encoded !== 'string' || encoded.length < 128 || encoded.length > 2048) {
            throw new Error(`Minecraft authentication key ${index} is invalid.`)
        }
        let key
        try {
            key = crypto.createPublicKey({
                key: Buffer.from(encoded, 'base64'),
                format: 'der',
                type: 'spki'
            })
        } catch(_err) {
            throw new Error(`Minecraft authentication key ${index} is not a valid SPKI key.`)
        }
        if(key.asymmetricKeyType !== 'rsa') {
            throw new Error(`Minecraft authentication key ${index} must be RSA.`)
        }
        return key
    })
}

function loadTrustedKeys(env = process.env) {
    const override = String(env.MINECRAFT_AUTH_KEYS_JSON || '').trim()
    if(!override) return parseKeyDocument(bundledKeyDocument)
    let document
    try {
        document = JSON.parse(override)
    } catch(_err) {
        throw new Error('MINECRAFT_AUTH_KEYS_JSON is not valid JSON.')
    }
    return parseKeyDocument(document)
}

const trustedKeys = loadTrustedKeys()

function numericClaim(payload, name) {
    const value = payload[name]
    if(!Number.isSafeInteger(value) || value <= 0) {
        reject('invalid_claims', `Minecraft token ${name} claim is invalid.`)
    }
    return value
}

function verifyMinecraftAccessToken(token, options = {}) {
    if(typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
        reject('malformed_token', 'Minecraft token is missing or exceeds the accepted size.')
    }
    const parts = token.split('.')
    if(parts.length !== 3 || parts.some(part => !part)) {
        reject('malformed_token', 'Minecraft token must be a three-part JWT.')
    }
    const header = decodeJsonSegment(parts[0], 'header')
    const payload = decodeJsonSegment(parts[1], 'payload')
    if(header.alg !== EXPECTED_ALGORITHM) {
        reject('invalid_algorithm', 'Minecraft token must use RS256.')
    }
    if(header.kid != null && (typeof header.kid !== 'string' || header.kid.length > 128)) {
        reject('invalid_claims', 'Minecraft token key identifier is invalid.')
    }
    if(!BASE64URL_PATTERN.test(parts[2])) {
        reject('malformed_token', 'Minecraft token signature is not valid base64url.')
    }
    const signature = Buffer.from(parts[2], 'base64url')
    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii')
    const keys = options.keys || trustedKeys
    if(!Array.isArray(keys) || keys.length === 0) {
        throw new Error('No trusted Minecraft authentication keys are configured.')
    }
    const signatureValid = keys.some(key => {
        try {
            return crypto.verify('RSA-SHA256', signingInput, key, signature)
        } catch(_err) {
            return false
        }
    })
    if(!signatureValid) {
        reject('invalid_signature', 'Minecraft token signature is invalid.')
    }
    if(payload.iss !== EXPECTED_ISSUER) {
        reject('invalid_issuer', 'Minecraft token issuer is invalid.')
    }
    const now = Number.isFinite(options.now) ? Math.floor(options.now) : Math.floor(Date.now() / 1000)
    const skew = Number.isFinite(options.clockSkewSeconds)
        ? Math.max(0, Math.floor(options.clockSkewSeconds))
        : DEFAULT_CLOCK_SKEW_SECONDS
    const issuedAt = numericClaim(payload, 'iat')
    const notBefore = numericClaim(payload, 'nbf')
    const expiresAt = numericClaim(payload, 'exp')
    if(issuedAt > now + skew || notBefore > now + skew) {
        reject('token_not_active', 'Minecraft token is not active yet.')
    }
    if(expiresAt <= now - skew) {
        reject('token_expired', 'Minecraft token has expired.')
    }
    if(expiresAt <= issuedAt || expiresAt - issuedAt > MAX_TOKEN_LIFETIME_SECONDS) {
        reject('invalid_claims', 'Minecraft token lifetime is invalid.')
    }
    const minecraftUuid = normalizeMinecraftUuid(payload.profiles?.mc)
    return {
        id: minecraftUuid,
        claims: {
            issuedAt,
            notBefore,
            expiresAt,
            subject: typeof payload.sub === 'string' ? payload.sub : null
        }
    }
}

module.exports = {
    DEFAULT_CLOCK_SKEW_SECONDS,
    MAX_TOKEN_LENGTH,
    MinecraftTokenVerificationError,
    loadTrustedKeys,
    normalizeMinecraftUuid,
    parseKeyDocument,
    trustedKeys,
    verifyMinecraftAccessToken
}
