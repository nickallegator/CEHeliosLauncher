'use strict'

;(() => {
    document.documentElement.dataset.homeFeeds = 'loading'
    const path = require('path')
    const { getSharedCommunityApiClient } = require('./assets/js/communitymanager')
    const {
        HomeFeedCoordinator,
        normalizeHomeCommunityEntries,
        primaryEngagement
    } = require('./assets/js/homefeedmanager')

    const newsList = document.getElementById('homeNewsList')
    const newsStatus = document.getElementById('homeNewsStatus')
    const newsCacheBadge = document.getElementById('homeNewsCacheBadge')
    const trendingList = document.getElementById('homeTrendingList')
    const trendingStatus = document.getElementById('homeTrendingStatus')
    const trendingCacheBadge = document.getElementById('homeTrendingCacheBadge')
    const logger = LoggerUtil.getLogger('HomeFeeds')
    const registry = window.CommunityModules.createDefaultCommunityContentRegistry({ environment: process.env })
    let communityClient = null
    let communityBase = null
    let communityCapabilities = null

    function copy(key, values){
        return Lang.query(`ejs.home.${key}`, values)
    }

    function empty(element){
        while(element?.firstChild) element.removeChild(element.firstChild)
    }

    function safeUrl(value, base = null){
        try {
            const parsed = new URL(String(value || ''), base || undefined)
            if(!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null
            return parsed.toString()
        } catch(_error){
            return null
        }
    }

    function setFeedStatus(element, message, visible = true){
        if(!element) return
        element.textContent = message || ''
        element.hidden = !visible
    }

    function renderSkeletons(list, count, kind){
        empty(list)
        list.dataset.state = 'loading'
        list.setAttribute('aria-busy', 'true')
        for(let index = 0; index < count; index += 1){
            const item = document.createElement('li')
            item.className = `homeFeedSkeleton ${kind}${index === 0 ? ' featured' : ''}`
            item.setAttribute('aria-hidden', 'true')
            item.append(document.createElement('span'), document.createElement('span'))
            list.append(item)
        }
    }

    function timeElement(article){
        const time = document.createElement('time')
        if(article.timestamp) time.dateTime = article.timestamp
        time.textContent = article.date || ''
        return time
    }

    function renderNews(state){
        if(!newsList) return
        const articles = Array.isArray(state.articles) ? state.articles.slice(0, 3) : []
        newsCacheBadge.hidden = state.cached !== true && state.offline !== true
        if(state.status === 'loading' && articles.length === 0){
            renderSkeletons(newsList, 3, 'news')
            setFeedStatus(newsStatus, copy('loadingNews'))
            return
        }
        if(state.status === 'error' && articles.length === 0){
            empty(newsList)
            newsList.dataset.state = 'error'
            newsList.setAttribute('aria-busy', 'false')
            setFeedStatus(newsStatus, copy('newsUnavailable'))
            return
        }
        if(articles.length === 0){
            empty(newsList)
            newsList.dataset.state = 'empty'
            newsList.setAttribute('aria-busy', 'false')
            setFeedStatus(newsStatus, copy('newsEmpty'))
            return
        }
        setFeedStatus(newsStatus, '', false)
        newsList.setAttribute('aria-busy', 'false')
        newsList.dataset.state = state.offline ? 'cached' : 'ready'
        empty(newsList)
        const unread = state.unread === true
        articles.forEach((article, index) => {
            const item = document.createElement('li')
            item.className = `homeNewsItem${index === 0 ? ' featured' : ''}`
            const button = document.createElement('button')
            button.type = 'button'
            button.className = 'homeFeedEntryButton'
            button.dataset.newsId = article.id
            if(index === 0 && unread) button.dataset.unread = 'true'
            const heading = document.createElement(index === 0 ? 'h2' : 'h3')
            heading.textContent = article.title || 'Untitled News'
            const meta = document.createElement('span')
            meta.className = 'homeFeedMeta'
            meta.append(timeElement(article))
            if(article.author){
                const author = document.createElement('span')
                author.textContent = article.author
                meta.append(author)
            }
            button.append(heading, meta)
            if(index === 0 && article.summary){
                const summary = document.createElement('p')
                summary.textContent = article.summary
                button.append(summary)
            }
            button.addEventListener('click', () => window.AGNewsFeed.openArticle(article.id).catch(error => logger.warn('Unable to open News article.', error)))
            item.append(button)
            newsList.append(item)
        })
    }

    function typeLabel(definition, type){
        try { return definition?.labelKey ? Lang.query(definition.labelKey) : type }
        catch(_error) { return type }
    }

    function createTypeFallback(definition){
        const fallback = document.createElement('span')
        fallback.className = 'homeTrendingFallback'
        fallback.setAttribute('aria-hidden', 'true')
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
        use.setAttribute('href', `assets/brand/allegator-icons.svg#${definition?.icon || 'community'}`)
        svg.append(use)
        fallback.append(svg)
        return fallback
    }

    function renderCommunity(state){
        if(!trendingList) return
        const items = Array.isArray(state.items) ? state.items.slice(0, 5) : []
        trendingCacheBadge.hidden = state.cached !== true && state.offline !== true
        if(state.status === 'loading' && items.length === 0){
            renderSkeletons(trendingList, 5, 'trending')
            setFeedStatus(trendingStatus, copy('loadingTrending'))
            return
        }
        if(state.status === 'error' && items.length === 0){
            empty(trendingList)
            trendingList.dataset.state = 'error'
            trendingList.setAttribute('aria-busy', 'false')
            setFeedStatus(trendingStatus, copy('trendingUnavailable'))
            return
        }
        if(items.length === 0){
            empty(trendingList)
            trendingList.dataset.state = 'empty'
            trendingList.setAttribute('aria-busy', 'false')
            setFeedStatus(trendingStatus, copy('trendingEmpty'))
            return
        }
        setFeedStatus(trendingStatus, '', false)
        trendingList.setAttribute('aria-busy', 'false')
        trendingList.dataset.state = state.offline ? 'cached' : 'ready'
        empty(trendingList)
        items.forEach((entry, index) => {
            const definition = registry.get(entry.communityType)
            const item = document.createElement('li')
            item.className = 'homeTrendingItem'
            const button = document.createElement('button')
            button.type = 'button'
            button.className = 'homeFeedEntryButton homeTrendingButton'
            button.dataset.communityKey = entry.communityKey
            const rank = document.createElement('span')
            rank.className = 'homeTrendingRank'
            rank.textContent = String(index + 1).padStart(2, '0')
            const media = document.createElement('span')
            media.className = 'homeTrendingMedia'
            const thumbnail = safeUrl(entry.thumbnailUrl, communityBase)
            const fallback = createTypeFallback(definition)
            media.append(fallback)
            if(thumbnail){
                const image = document.createElement('img')
                image.src = thumbnail
                image.alt = ''
                image.loading = 'lazy'
                image.addEventListener('load', () => { fallback.hidden = true }, { once: true })
                image.addEventListener('error', () => image.remove(), { once: true })
                media.append(image)
            }
            const body = document.createElement('span')
            body.className = 'homeTrendingCopy'
            const title = document.createElement('strong')
            title.textContent = entry.title || entry.name || 'Community Creation'
            const meta = document.createElement('span')
            meta.textContent = `${typeLabel(definition, entry.communityType)} · ${entry.creator || 'Minecraft Player'}`
            const engagement = primaryEngagement(entry)
            const stats = document.createElement('small')
            stats.textContent = copy(engagement.kind, { count: engagement.value })
            body.append(title, meta, stats)
            button.append(rank, media, body)
            button.addEventListener('click', () => openCommunityItem({ type: entry.communityType, id: entry.id, seedEntry: entry }).catch(error => logger.warn('Unable to open Community creation.', error)))
            item.append(button)
            trendingList.append(item)
        })
    }

    async function resolveCommunityContext(){
        const distribution = await DistroAPI.getDistribution()
        const rawDistribution = distribution?.rawDistribution || {}
        const configured = String(process.env.HELIOS_SCHEMATICS_API_URL || '').trim()
        const community = rawDistribution.community || {}
        const schematics = rawDistribution.schematics || {}
        const enabled = Boolean(configured || community.enabled === true || (!rawDistribution.community && schematics.enabled === true))
        const base = String(configured || community.apiBaseUrl || schematics.apiBaseUrl || '').replace(/\/+$/, '')
        if(!enabled || Number(community.schemaVersion || 1) !== 1 || !safeUrl(base)) throw new Error('Community service is not configured.')
        if(!communityClient || communityBase !== base){
            communityBase = base
            communityCapabilities = null
            communityClient = getSharedCommunityApiClient({
                baseUrl: base,
                cachePath: path.join(ConfigManager.getLauncherDirectory(), 'schematics-cache', 'community-catalog-v1.json'),
                timeoutMs: 10000
            })
        }
        return { client: communityClient, distribution, rawDistribution }
    }

    async function loadCommunity({ signal }){
        const context = await resolveCommunityContext()
        communityCapabilities ||= await context.client.capabilities({ signal })
        const definitions = await registry.enabled({ rawDistribution: context.rawDistribution, capabilities: communityCapabilities })
        const catalog = await context.client.catalog({ category: 'all', sort: 'popular', limit: '5' }, { signal })
        return {
            items: normalizeHomeCommunityEntries(catalog.items, definitions),
            cached: catalog.cached === true,
            offline: catalog.offline === true,
            fetchedAt: catalog.cacheFetchedAt || null
        }
    }

    async function cachedCommunity(){
        try {
            const context = await resolveCommunityContext()
            const cached = context.client.readCommunityCache('category=all&limit=5&sort=popular')
            if(!cached?.catalog?.items) return null
            const definitions = [...registry.definitions.values()]
            return {
                items: normalizeHomeCommunityEntries(cached.catalog.items, definitions),
                cached: true,
                offline: true,
                fetchedAt: cached.fetchedAt || null
            }
        } catch(_error){
            return null
        }
    }

    async function openCommunityItem({ type, id, seedEntry }){
        if(!type || !id) return false
        const origin = document.activeElement
        const originCommunityKey = origin?.dataset?.communityKey || `${type}:${id}`
        await window.AppShell.navigate('community')
        await ensureSchematicsReady()
        const activeRegistry = typeof communityContentRegistry !== 'undefined' ? communityContentRegistry : null
        const definition = activeRegistry?.get(type) || registry.get(type)
        if(!definition) return false
        const entry = seedEntry || (typeof getCommunityEntryByKey === 'function' ? getCommunityEntryByKey(`${type}:${id}`) : null)
        if(!entry) return false
        const detailRoot = document.getElementById(type === 'schematics' ? 'schematicsDetail' : 'communityContentDetail')
        let observer = null
        if(detailRoot && origin?.isConnected){
            observer = new MutationObserver(() => {
                if(detailRoot.getAttribute('aria-hidden') !== 'true' && !detailRoot.hidden) return
                observer.disconnect()
                if(window.AppShell?.getRoute?.() === 'community'){
                    window.AppShell.navigate('home').then(() => {
                        requestAnimationFrame(() => requestAnimationFrame(() => {
                            const focusTarget = [...document.querySelectorAll('#homeTrendingList .homeTrendingButton')]
                                .find(button => button.dataset.communityKey === originCommunityKey)
                            ;(focusTarget || origin)?.focus?.()
                        }))
                    }).catch(() => {})
                }
            })
            observer.observe(detailRoot, { attributes: true, attributeFilter: ['aria-hidden', 'hidden'] })
        }
        try {
            await definition.openDetail(entry, {
                openSchematicDetail,
                openGenericCommunityDetail: window.openGenericCommunityDetail
            })
        } catch(error){
            observer?.disconnect()
            throw error
        }
        return true
    }

    const coordinator = new HomeFeedCoordinator({
        newsLoader: ({ signal }) => window.AGNewsFeed.load({ allowCached: true, signal }),
        communityLoader: loadCommunity,
        renderNews,
        renderCommunity
    })

    async function activate(){
        if(window.AppShell?.getRoute?.() !== 'home') return
        if(coordinator.active) return coordinator.refresh()
        const [news, community] = await Promise.allSettled([window.AGNewsFeed.cached(), cachedCommunity()])
        if(window.AppShell?.getRoute?.() !== 'home') return
        return coordinator.activate({
            cachedNews: news.status === 'fulfilled' ? news.value : null,
            cachedCommunity: community.status === 'fulfilled' ? community.value : null
        })
    }

    document.getElementById('homeNewsAllButton')?.addEventListener('click', () => window.AppShell.navigate('news'))
    window.addEventListener('helios:shell-route-change', event => {
        if(event.detail?.route === 'home' && !document.hidden) activate().catch(error => logger.warn('Unable to activate Home feeds.', error))
        else coordinator.deactivate()
    })
    window.addEventListener('helios:distribution-refresh', () => {
        communityCapabilities = null
        if(window.AppShell?.getRoute?.() === 'home') activate().then(() => coordinator.refresh({ force: true })).catch(() => {})
    })
    document.addEventListener('visibilitychange', () => {
        if(document.hidden) coordinator.deactivate()
        else activate().catch(() => {})
    })
    window.addEventListener('beforeunload', () => coordinator.destroy(), { once: true })

    window.AGHomeFeeds = { activate, coordinator, openCommunityItem, renderCommunity, renderNews }
    document.documentElement.dataset.homeFeeds = 'ready'
    activate().catch(error => {
        document.documentElement.dataset.homeFeeds = `error:${String(error?.message || error).slice(0, 120)}`
        logger.warn('Unable to initialize Home feeds.', error)
    })
})()
