'use strict'

const db = require('../db')

function floorWindow(date, windowMs) {
    return new Date(Math.floor(date.getTime() / windowMs) * windowMs)
}

async function consume({ subject, action, limit, windowMs, now = new Date(), client = db }) {
    const normalizedSubject = String(subject)
    const normalizedAction = String(action)
    const normalizedLimit = Math.max(1, Number(limit) || 1)
    const normalizedWindow = Math.max(1000, Number(windowMs) || 60_000)
    const windowStart = floorWindow(now, normalizedWindow)
    const result = await client.query(
        `insert into schematic_rate_limits(subject, action, window_start, count)
         values ($1, $2, $3, 1)
         on conflict (subject, action, window_start) do update
         set count = schematic_rate_limits.count + 1, updated_at = now()
         returning count`,
        [normalizedSubject, normalizedAction, windowStart]
    )
    const count = Number(result.rows[0].count)
    return {
        allowed: count <= normalizedLimit,
        count,
        limit: normalizedLimit,
        remaining: Math.max(0, normalizedLimit - count),
        resetAt: new Date(windowStart.getTime() + normalizedWindow)
    }
}

async function cleanup(before = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000))) {
    return db.query('delete from schematic_rate_limits where updated_at < $1', [before])
}

module.exports = { cleanup, consume, floorWindow }
