const sessions = require('../services/sessions')

function readBearerToken(req) {
    const auth = req.headers.authorization || ''
    const parts = auth.split(' ')
    return parts.length === 2 && parts[0].toLowerCase() === 'bearer' ? parts[1] : null
}

async function requireSession(req, res, next) {
    try {
        const token = readBearerToken(req)
        if(!token) {
            res.status(401).json({ error: 'missing_token' })
            return
        }
        const session = await sessions.getSession(token)
        if(!session) {
            res.status(401).json({ error: 'invalid_token' })
            return
        }
        req.userId = session.userId
        req.sessionExpiresAt = session.expiresAt
        next()
    } catch(err) {
        next(err)
    }
}

module.exports = { readBearerToken, requireSession }
