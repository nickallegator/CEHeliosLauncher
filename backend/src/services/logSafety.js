'use strict'

function redactUrlQueries(value) {
    return String(value || '').replace(/https?:\/\/[^\s"'<>]+/gi, match => {
        try {
            const parsed = new URL(match)
            return `${parsed.origin}${parsed.pathname}${parsed.search ? '?[redacted]' : ''}`
        } catch(_err) {
            return '[invalid URL]'
        }
    })
}

function safeError(error) {
    return {
        name: error?.name || 'Error',
        code: error?.code || error?.name || null,
        statusCode: error?.$metadata?.httpStatusCode || error?.statusCode || null,
        message: redactUrlQueries(error?.message || 'Unknown error')
    }
}

module.exports = { redactUrlQueries, safeError }
