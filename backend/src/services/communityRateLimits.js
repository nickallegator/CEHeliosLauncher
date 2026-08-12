'use strict'

const db = require('../db')

function floorWindow(date, windowMs) {
    return new Date(Math.floor(date.getTime() / windowMs) * windowMs)
}

async function consume({ subject, action, limit, windowMs, now = new Date(), client = db }) {
    const normalizedLimit = Math.max(1, Number(limit) || 1)
    const normalizedWindow = Math.max(1000, Number(windowMs) || 60_000)
    const windowStart = floorWindow(now, normalizedWindow)
    const result = await client.query(
        `insert into community_rate_limits(subject, action, window_start, count)
         values ($1, $2, $3, 1)
         on conflict (subject, action, window_start) do update
         set count = community_rate_limits.count + 1, updated_at = now()
         returning count`,
        [String(subject), String(action), windowStart]
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

module.exports = { consume, floorWindow }
