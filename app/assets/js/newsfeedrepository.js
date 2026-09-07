'use strict'

const crypto = require('crypto')
const got = require('got')

const NEWS_CACHE_SCHEMA = 1
const NEWS_CACHE_LIMIT = 10
const NEWS_EXCERPT_LIMIT = 220
const NEWS_MEMORY_TTL_MS = 15 * 60 * 1000

const ALLOWED_TAGS = new Set([
    'a', 'b', 'blockquote', 'br', 'code', 'div', 'em', 'h1', 'h2', 'h3', 'h4',
    'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 'span', 'strong', 'u', 'ul'
])
const VOID_TAGS = new Set(['br', 'hr', 'img'])
const SAFE_NEWS_CLASSES = new Set(['bbCodeSpoilerButton', 'bbCodeSpoilerText'])

function decodeEntities(value){
    const named = { amp: '&', apos: '\'', gt: '>', lt: '<', nbsp: ' ', quot: '"' }
    return String(value || '').replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (match, entity) => {
        if(entity[0] === '#'){
            const hexadecimal = entity[1]?.toLowerCase() === 'x'
            const code = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10)
            return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
        }
        return named[entity.toLowerCase()] ?? match
    })
}

function stripArticleMarkup(value){
    return decodeEntities(String(value || '')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(script|style|iframe|object|embed|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/\s*(p|div|h[1-6]|li|blockquote|pre)\s*>/gi, '\n')
        .replace(/<[^>]+>/g, ' '))
        .replace(/[\t\f\v ]+/g, ' ')
        .replace(/ +([.,!?;:])/g, '$1')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

function escapeAttribute(value){
    return String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function safeHttpUrl(value, baseUrl = null){
    try {
        const parsed = new URL(String(value || '').trim(), baseUrl || undefined)
        if(!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null
        return parsed.toString()
    } catch(_error){
        return null
    }
}

function safeImageUrl(value, baseUrl = null){
    const raw = String(value || '').trim()
    if(/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(raw)) return raw
    return safeHttpUrl(raw, baseUrl)
}

function readAttribute(source, name){
    const match = String(source || '').match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))
    return match ? (match[1] ?? match[2] ?? '') : ''
}

function sanitizeArticleHtml(value, baseUrl = null){
    const source = String(value || '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(script|style|iframe|object|embed|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    return (source.match(/<[^>]*>|[^<]+/g) || []).map(token => {
        if(!token.startsWith('<')) return token
        const match = token.match(/^<\s*(\/?)\s*([a-z0-9-]+)/i)
        if(!match) return ''
        const closing = match[1] === '/'
        const tag = match[2].toLowerCase()
        if(!ALLOWED_TAGS.has(tag)) return ''
        if(closing) return VOID_TAGS.has(tag) ? '' : `</${tag}>`
        if(tag === 'a'){
            const href = safeHttpUrl(readAttribute(token, 'href'), baseUrl)
            return href ? `<a href="${escapeAttribute(href)}" rel="noopener noreferrer">` : '<a>'
        }
        if(tag === 'img'){
            const src = safeImageUrl(readAttribute(token, 'src'), baseUrl)
            if(!src) return ''
            const alt = stripArticleMarkup(readAttribute(token, 'alt')).slice(0, 180)
            return `<img src="${escapeAttribute(src)}" alt="${escapeAttribute(alt)}" loading="lazy">`
        }
        const className = readAttribute(token, 'class').split(/\s+/).find(name => SAFE_NEWS_CLASSES.has(name))
        return `<${tag}${className ? ` class="${className}"` : ''}>`
    }).join('')
}

function stableArticleId(guid, link){
    const seed = String(guid || '').trim() || String(link || '').trim()
    return crypto.createHash('sha1').update(seed).digest('hex')
}

function xmlText(parent, name){
    const node = parent.getElementsByTagName(name)?.[0]
    return String(node?.textContent || '').trim()
}

function parseRssXml(xml, options = {}){
    const Parser = options.DOMParser || globalThis.DOMParser
    if(typeof Parser !== 'function') throw new Error('An XML DOM parser is required for News feeds.')
    const document = new Parser().parseFromString(String(xml || ''), 'application/xml')
    if(document.querySelector?.('parsererror')) throw new Error('The News feed contains malformed XML.')
    const sourceUrl = safeHttpUrl(options.sourceUrl)
    const sourceBase = sourceUrl ? new URL('/', sourceUrl).toString() : null
    return Array.from(document.getElementsByTagName('item')).slice(0, NEWS_CACHE_LIMIT).map(item => {
        const link = safeHttpUrl(xmlText(item, 'link'), sourceBase)
        const guid = xmlText(item, 'guid')
        const rawContent = xmlText(item, 'content:encoded') || xmlText(item, 'description')
        const content = sanitizeArticleHtml(rawContent, sourceBase)
        const published = new Date(xmlText(item, 'pubDate'))
        const timestamp = Number.isNaN(published.getTime()) ? null : published.toISOString()
        const commentsValue = Math.max(0, Number.parseInt(xmlText(item, 'slash:comments') || '0', 10) || 0)
        return {
            id: stableArticleId(guid, link),
            guid: guid || null,
            link,
            title: stripArticleMarkup(xmlText(item, 'title')).slice(0, 240) || 'Untitled News',
            author: stripArticleMarkup(xmlText(item, 'dc:creator')).slice(0, 120) || 'Allegator Games',
            timestamp,
            date: timestamp ? published.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric' }) : '',
            content,
            summary: stripArticleMarkup(content).slice(0, NEWS_EXCERPT_LIMIT),
            comments: `${commentsValue} Comment${commentsValue === 1 ? '' : 's'}`,
            commentsLink: link ? `${link}#comments` : null
        }
    })
}

function cacheSafeArticles(articles){
    return articles.slice(0, NEWS_CACHE_LIMIT).map(({ id, link, title, author, timestamp, date, summary, comments, commentsLink }) => ({
        id, link, title, author, timestamp, date, summary, comments, commentsLink
    }))
}

function abortedError(){
    return Object.assign(new Error('News request was cancelled.'), { name: 'AbortError', code: 'aborted' })
}

function observeAbort(promise, signal){
    if(!signal) return promise
    if(signal.aborted) return Promise.reject(abortedError())
    return new Promise((resolve, reject) => {
        const abort = () => reject(abortedError())
        signal.addEventListener('abort', abort, { once: true })
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
}

class NewsFeedRepository {
    constructor(options = {}){
        this.fetchText = options.fetchText || (async url => (await got(url, {
            timeout: { request: options.timeoutMs || 2500 },
            retry: { limit: 0 },
            headers: { Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8' }
        })).body)
        this.parseXml = options.parseXml || ((xml, context) => parseRssXml(xml, context))
        this.readCache = options.readCache || (() => null)
        this.writeCache = options.writeCache || (() => {})
        this.now = options.now || (() => Date.now())
        this.memoryTtlMs = options.memoryTtlMs || NEWS_MEMORY_TTL_MS
        this.memory = new Map()
        this.inflight = new Map()
    }

    cached(url){
        const cache = this.readCache()
        if(cache?.schemaVersion !== NEWS_CACHE_SCHEMA || cache.sourceUrl !== url || !Array.isArray(cache.articles)) return null
        return { articles: cache.articles.slice(0, NEWS_CACHE_LIMIT), cached: true, offline: true, fetchedAt: cache.fetchedAt || null }
    }

    async load(options = {}){
        const url = safeHttpUrl(options.url)
        if(!url) throw new Error('A valid News RSS URL is required.')
        const memory = this.memory.get(url)
        if(!options.force && memory && this.now() - memory.loadedAt < this.memoryTtlMs){
            return observeAbort(Promise.resolve({ articles: memory.articles, cached: false, offline: false, fetchedAt: memory.fetchedAt }), options.signal)
        }
        let request = this.inflight.get(url)
        if(!request){
            request = (async () => {
                const xml = await this.fetchText(url)
                const articles = this.parseXml(xml, { sourceUrl: url })
                const fetchedAt = new Date(this.now()).toISOString()
                this.memory.set(url, { articles, fetchedAt, loadedAt: this.now() })
                this.writeCache({ schemaVersion: NEWS_CACHE_SCHEMA, sourceUrl: url, fetchedAt, articles: cacheSafeArticles(articles) })
                return { articles, cached: false, offline: false, fetchedAt }
            })().finally(() => this.inflight.delete(url))
            this.inflight.set(url, request)
        }
        try {
            return await observeAbort(request, options.signal)
        } catch(error){
            if(error?.name === 'AbortError') throw error
            const cached = options.allowCached !== false ? this.cached(url) : null
            if(cached) return cached
            throw error
        }
    }
}

module.exports = {
    NEWS_CACHE_LIMIT,
    NEWS_CACHE_SCHEMA,
    NEWS_EXCERPT_LIMIT,
    NEWS_MEMORY_TTL_MS,
    NewsFeedRepository,
    cacheSafeArticles,
    parseRssXml,
    safeHttpUrl,
    sanitizeArticleHtml,
    stableArticleId,
    stripArticleMarkup
}
