function createRateLimit(options = {}) {
    const windowMs = Number(options.windowMs) || 60_000
    const limit = Number(options.limit) || 30
    const buckets = new Map()

    const cleanup = setInterval(() => {
        const now = Date.now()
        for(const [key, value] of buckets) {
            if(value.resetAt <= now) buckets.delete(key)
        }
    }, Math.max(windowMs, 30_000))
    if(typeof cleanup.unref === 'function') cleanup.unref()

    return (req, res, next) => {
        const now = Date.now()
        const key = options.keyGenerator ? options.keyGenerator(req) : (req.ip || 'unknown')
        let bucket = buckets.get(key)
        if(!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + windowMs }
            buckets.set(key, bucket)
        }
        bucket.count++
        res.set('X-RateLimit-Limit', String(limit))
        res.set('X-RateLimit-Remaining', String(Math.max(0, limit - bucket.count)))
        if(bucket.count > limit) {
            res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)))
            res.status(429).json({ error: 'rate_limited' })
            return
        }
        next()
    }
}

module.exports = { createRateLimit }
