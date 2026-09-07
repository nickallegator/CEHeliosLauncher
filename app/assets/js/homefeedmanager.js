'use strict'

const DEFAULT_NEWS_REFRESH_MS = 15 * 60 * 1000
const DEFAULT_COMMUNITY_REFRESH_MS = 5 * 60 * 1000
const HOME_COMMUNITY_LIMIT = 5

function normalizeHomeCommunityEntries(entries, definitions, limit = HOME_COMMUNITY_LIMIT){
    const byType = new Map((definitions || []).map(definition => [definition.id, definition]))
    const unique = new Map()
    for(const raw of entries || []){
        const definition = byType.get(raw?.type)
        const normalized = definition?.normalize?.(raw)
        const key = normalized?.communityKey || (normalized?.id ? `${raw.type}:${normalized.id}` : null)
        if(key && !unique.has(key)) unique.set(key, { ...normalized, communityType: raw.type })
        if(unique.size >= limit) break
    }
    return [...unique.values()]
}

function primaryEngagement(entry){
    const likes = Math.max(0, Number(entry?.likes ?? entry?.stats?.likes) || 0)
    const downloads = Math.max(0, Number(entry?.downloads ?? entry?.stats?.downloads) || 0)
    const views = Math.max(0, Number(entry?.views ?? entry?.stats?.views) || 0)
    if(likes > 0) return { kind: 'likes', value: likes }
    if(downloads > 0) return { kind: 'downloads', value: downloads }
    return { kind: 'views', value: views }
}

class HomeFeedCoordinator {
    constructor(options = {}){
        this.newsLoader = options.newsLoader
        this.communityLoader = options.communityLoader
        this.renderNews = options.renderNews || (() => {})
        this.renderCommunity = options.renderCommunity || (() => {})
        this.now = options.now || (() => Date.now())
        this.setInterval = options.setInterval || ((callback, delay) => setInterval(callback, delay))
        this.clearInterval = options.clearInterval || (timer => clearInterval(timer))
        this.newsRefreshMs = options.newsRefreshMs || DEFAULT_NEWS_REFRESH_MS
        this.communityRefreshMs = options.communityRefreshMs || DEFAULT_COMMUNITY_REFRESH_MS
        this.active = false
        this.epoch = 0
        this.interval = null
        this.lastNewsAt = 0
        this.lastCommunityAt = 0
        this.controllers = new Map()
        this.pending = new Map()
    }

    activate(options = {}){
        if(this.active) return this.refresh(options)
        this.active = true
        this.epoch += 1
        if(options.cachedNews) this.renderNews({ status: 'ready', ...options.cachedNews })
        else this.renderNews({ status: 'loading', articles: [] })
        if(options.cachedCommunity) this.renderCommunity({ status: 'ready', ...options.cachedCommunity })
        else this.renderCommunity({ status: 'loading', items: [] })
        this.interval = this.setInterval(() => this.refresh().catch(() => {}), 60 * 1000)
        return this.refresh({ force: true })
    }

    deactivate(){
        if(!this.active) return
        this.active = false
        this.epoch += 1
        if(this.interval) this.clearInterval(this.interval)
        this.interval = null
        for(const controller of this.controllers.values()) controller.abort()
        this.controllers.clear()
        this.pending.clear()
    }

    destroy(){ this.deactivate() }

    async refresh(options = {}){
        if(!this.active) return
        const now = this.now()
        const jobs = []
        if(options.force || now - this.lastNewsAt >= this.newsRefreshMs) jobs.push(this.refreshOne('news', this.newsLoader, this.renderNews))
        if(options.force || now - this.lastCommunityAt >= this.communityRefreshMs) jobs.push(this.refreshOne('community', this.communityLoader, this.renderCommunity))
        await Promise.allSettled(jobs)
    }

    async refreshOne(kind, loader, renderer){
        if(typeof loader !== 'function' || this.pending.has(kind)) return this.pending.get(kind)
        const epoch = this.epoch
        const controller = new AbortController()
        this.controllers.set(kind, controller)
        const promise = Promise.resolve().then(() => loader({ signal: controller.signal })).then(result => {
            if(!this.active || epoch !== this.epoch || controller.signal.aborted) return
            this[kind === 'news' ? 'lastNewsAt' : 'lastCommunityAt'] = this.now()
            renderer({ status: 'ready', ...result })
        }).catch(error => {
            if(error?.name === 'AbortError' || controller.signal.aborted || !this.active || epoch !== this.epoch) return
            renderer({ status: 'error', error, [kind === 'news' ? 'articles' : 'items']: [] })
        }).finally(() => {
            if(this.controllers.get(kind) === controller) this.controllers.delete(kind)
            this.pending.delete(kind)
        })
        this.pending.set(kind, promise)
        return promise
    }
}

module.exports = {
    DEFAULT_COMMUNITY_REFRESH_MS,
    DEFAULT_NEWS_REFRESH_MS,
    HOME_COMMUNITY_LIMIT,
    HomeFeedCoordinator,
    normalizeHomeCommunityEntries,
    primaryEngagement
}
