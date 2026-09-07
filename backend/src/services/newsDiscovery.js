'use strict'

function normalizeBaseUrl(value, options = {}) {
    if(!value) return null
    let parsed
    try {
        parsed = new URL(String(value).trim())
    } catch(_error) {
        throw new Error('NEWS_PUBLIC_BASE_URL must be a valid URL')
    }
    if(parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error('NEWS_PUBLIC_BASE_URL cannot contain credentials, a query, or a fragment')
    }
    if(!['http:', 'https:'].includes(parsed.protocol)) throw new Error('NEWS_PUBLIC_BASE_URL must use HTTP or HTTPS')
    if(options.production && parsed.protocol !== 'https:') throw new Error('NEWS_PUBLIC_BASE_URL must use HTTPS in production')
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') + '/'
    return parsed
}

function createNewsDiscovery(settings, options = {}) {
    if(!settings?.enabled) return null
    const base = normalizeBaseUrl(settings.publicBaseUrl, options)
    if(!base) throw new Error('NEWS_PUBLIC_BASE_URL is required when News is enabled')
    return {
        schemaVersion: 1,
        enabled: true,
        indexUrl: new URL('api/v1/news.json', base).toString(),
        rssUrl: new URL('rss.xml', base).toString(),
        siteUrl: new URL('.', base).toString().replace(/\/$/, ''),
        refreshSeconds: Math.min(86400, Math.max(60, Number(settings.refreshSeconds) || 900))
    }
}

function injectNewsService(distribution, settings, options = {}) {
    const discovery = createNewsDiscovery(settings, options)
    if(!discovery) return distribution
    distribution.rss = discovery.rssUrl
    distribution.news = discovery
    return distribution
}

module.exports = { createNewsDiscovery, injectNewsService, normalizeBaseUrl }
