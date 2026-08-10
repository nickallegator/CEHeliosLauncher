const crypto = require('crypto')
const config = require('../config')
const db = require('../db')

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex')
}

function generateToken() {
    return crypto.randomBytes(32).toString('base64url')
}

async function createSession(userId) {
    const token = generateToken()
    const tokenHash = hashToken(token)
    const expiresAt = new Date(Date.now() + config.sessionTtlDays * 24 * 60 * 60 * 1000)

    await db.query(
        'insert into sessions (user_id, token_hash, expires_at) values ($1, $2, $3)',
        [userId, tokenHash, expiresAt]
    )

    return { token, expiresAt }
}

async function getSession(token) {
    if(!token) {
        return null
    }
    const tokenHash = hashToken(token)
    const { rows } = await db.query(
        'select user_id, expires_at from sessions where token_hash = $1',
        [tokenHash]
    )
    if(rows.length === 0) {
        return null
    }
    const session = rows[0]
    if(new Date(session.expires_at).getTime() < Date.now()) {
        return null
    }
    return { userId: session.user_id, expiresAt: session.expires_at }
}

module.exports = {
    createSession,
    getSession
}
