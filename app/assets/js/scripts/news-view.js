'use strict'

const {
    adjacentArticleId,
    availableCategories,
    categoryLabel,
    filterArticles,
    selectedArticleId,
    trustedHeroImage
} = require('./assets/js/newsviewmodel')

const fallbackCopy = Object.freeze({
    all: 'All',
    checking: 'Checking for News…',
    cached: 'Cached news',
    current: 'Up to date',
    unavailable: 'News temporarily unavailable',
    emptyResults: 'No articles match these filters.',
    resultCount: '{count} articles',
    resultCountOne: '1 article',
    position: '{current} of {total}',
    byAuthor: 'By {author}',
    categoryAnnouncement: 'Announcement',
    categoryLauncherRelease: 'Launcher Release',
    categoryModRelease: 'Mod Release',
    categoryCommunity: 'Community',
    categoryMaintenance: 'Maintenance'
})

function copy(key, values = {}){
    let value
    try { value = Lang.query(`ejs.newsPage.${key}`, values) } catch (_error) { value = null }
    if(!value || value === `ejs.newsPage.${key}`) value = fallbackCopy[key] || key
    return Object.entries(values).reduce((text, [name, replacement]) => text.replaceAll(`{${name}}`, String(replacement)), String(value))
}

function displayCategory(category){
    const known = {
        announcement: 'categoryAnnouncement',
        'launcher-release': 'categoryLauncherRelease',
        'mod-release': 'categoryModRelease',
        community: 'categoryCommunity',
        maintenance: 'categoryMaintenance'
    }
    return known[category] ? copy(known[category]) : categoryLabel(category)
}

function createNewsView(){
    const root = document.getElementById('newsContainer')
    if(!root) return null

    const elements = {
        workspace: document.getElementById('newsContent'),
        archive: document.getElementById('newsArchive'),
        archiveNavigation: document.getElementById('newsArchiveNavigation'),
        archiveList: document.getElementById('newsArchiveList'),
        archiveToggle: document.getElementById('newsArchiveToggle'),
        archiveClose: document.getElementById('newsArchiveClose'),
        archiveScrim: document.getElementById('newsArchiveScrim'),
        search: document.getElementById('newsSearchInput'),
        categories: document.getElementById('newsCategoryFilters'),
        resultCount: document.getElementById('newsResultCount'),
        badge: document.getElementById('newsFeedStateBadge'),
        refresh: document.getElementById('newsRefreshButton'),
        article: document.getElementById('newsArticleContainer'),
        scrollable: document.getElementById('newsArticleContentScrollable'),
        body: document.getElementById('newsArticleContent'),
        title: document.getElementById('newsArticleTitle'),
        author: document.getElementById('newsArticleAuthor'),
        date: document.getElementById('newsArticleDate'),
        category: document.getElementById('newsArticleCategory'),
        tags: document.getElementById('newsArticleTags'),
        hero: document.getElementById('newsArticleHero'),
        heroImage: document.getElementById('newsArticleHeroImage'),
        previous: document.getElementById('newsNavigateLeft'),
        next: document.getElementById('newsNavigateRight'),
        navigationStatus: document.getElementById('newsNavigationStatus'),
        readerPosition: document.getElementById('newsReaderPosition'),
        openWeb: document.getElementById('newsOpenWeb'),
        statePanel: document.getElementById('newsErrorContainer'),
        loading: document.getElementById('newsErrorLoading'),
        failed: document.getElementById('newsErrorFailed'),
        empty: document.getElementById('newsErrorNone'),
        retry: document.getElementById('newsErrorRetry')
    }

    const state = {
        active: false,
        articles: [],
        filtered: [],
        selectedId: null,
        pendingArticleId: null,
        query: '',
        category: 'all',
        cached: false,
        offline: false,
        archiveOpen: false,
        archiveScrollTop: 0,
        readingPositions: new Map(),
        requestSequence: 0,
        requestPromise: null,
        abortController: null,
        returnFocus: null,
        returnFocusNewsId: null
    }

    function setBadge(kind, label){
        elements.badge.dataset.state = kind
        elements.badge.textContent = label
    }

    function setViewState(kind){
        elements.workspace.dataset.state = kind
        const ready = kind === 'ready'
        elements.article.hidden = !ready
        elements.statePanel.hidden = ready
        elements.loading.hidden = kind !== 'loading'
        elements.failed.hidden = kind !== 'error'
        elements.empty.hidden = kind !== 'empty'
    }

    function setArchiveOpen(open){
        state.archiveOpen = Boolean(open)
        elements.archive.dataset.open = String(state.archiveOpen)
        elements.archiveToggle.setAttribute('aria-expanded', String(state.archiveOpen))
        elements.archiveScrim.hidden = !state.archiveOpen
        if(state.archiveOpen) elements.search.focus()
    }

    function saveReadingPosition(){
        if(state.selectedId) state.readingPositions.set(state.selectedId, elements.scrollable.scrollTop)
        state.archiveScrollTop = elements.archiveNavigation.scrollTop
    }

    function renderCategories(){
        const categories = availableCategories(state.articles)
        if(state.category !== 'all' && !categories.includes(state.category)) state.category = 'all'
        const fragment = document.createDocumentFragment()
        for(const category of ['all', ...categories]){
            const button = document.createElement('button')
            button.type = 'button'
            button.className = 'newsCategoryChip'
            button.dataset.newsCategory = category
            button.setAttribute('aria-pressed', String(state.category === category))
            button.textContent = category === 'all' ? copy('all') : displayCategory(category)
            fragment.append(button)
        }
        elements.categories.replaceChildren(fragment)
    }

    function renderArchive(){
        const fragment = document.createDocumentFragment()
        if(state.filtered.length === 0){
            const item = document.createElement('li')
            item.className = 'newsArchiveEmpty'
            item.textContent = copy('emptyResults')
            fragment.append(item)
        } else {
            state.filtered.forEach(article => {
                const item = document.createElement('li')
                const button = document.createElement('button')
                button.type = 'button'
                button.className = 'newsArchiveItemButton'
                button.dataset.newsArticleId = article.id
                button.setAttribute('aria-current', String(article.id === state.selectedId))

                const meta = document.createElement('span')
                meta.className = 'newsArchiveItemMeta'
                const category = document.createElement('span')
                category.className = 'newsArchiveItemCategory'
                category.textContent = displayCategory(article.category)
                const date = document.createElement('span')
                date.textContent = article.date || ''
                meta.append(category, date)

                const title = document.createElement('span')
                title.className = 'newsArchiveItemTitle'
                title.textContent = article.title || 'Untitled News'
                const summary = document.createElement('span')
                summary.className = 'newsArchiveItemSummary'
                summary.textContent = article.summary || ''
                button.append(meta, title, summary)
                item.append(button)
                fragment.append(item)
            })
        }
        elements.archiveList.replaceChildren(fragment)
        elements.archiveNavigation.scrollTop = state.archiveScrollTop
        const count = state.filtered.length
        elements.resultCount.textContent = count === 1 ? copy('resultCountOne') : copy('resultCount', { count })
    }

    function updateNavigation(){
        const current = state.filtered.findIndex(article => article.id === state.selectedId)
        const position = current >= 0 ? copy('position', { current: current + 1, total: state.filtered.length }) : ''
        elements.navigationStatus.textContent = position
        elements.readerPosition.textContent = position
        elements.previous.disabled = !adjacentArticleId(state.filtered, state.selectedId, -1)
        elements.next.disabled = !adjacentArticleId(state.filtered, state.selectedId, 1)
    }

    function renderHero(article){
        const heroUrl = trustedHeroImage(article)
        elements.hero.dataset.category = article.category || 'announcement'
        elements.hero.dataset.hasImage = String(Boolean(heroUrl))
        elements.heroImage.hidden = !heroUrl
        elements.heroImage.removeAttribute('src')
        if(heroUrl) elements.heroImage.src = heroUrl
    }

    function selectArticle(id, options = {}){
        const article = state.articles.find(candidate => candidate.id === id)
        if(!article) return false
        saveReadingPosition()
        state.selectedId = article.id
        state.pendingArticleId = null

        elements.title.textContent = article.title || 'Untitled News'
        if(article.link) elements.title.href = article.link
        else elements.title.removeAttribute('href')
        elements.author.textContent = copy('byAuthor', { author: article.author || 'Allegator Games' })
        elements.date.textContent = article.date || ''
        if(article.timestamp) elements.date.dateTime = article.timestamp
        else elements.date.removeAttribute('datetime')
        elements.category.textContent = displayCategory(article.category)
        elements.body.innerHTML = article.content || ''

        const tagFragment = document.createDocumentFragment()
        for(const value of Array.isArray(article.tags) ? article.tags : []){
            const tag = document.createElement('span')
            tag.className = 'newsArticleTag'
            tag.textContent = value
            tagFragment.append(tag)
        }
        elements.tags.replaceChildren(tagFragment)
        elements.tags.hidden = elements.tags.childElementCount === 0

        if(article.link){
            elements.openWeb.href = article.link
            elements.openWeb.hidden = false
        } else {
            elements.openWeb.removeAttribute('href')
            elements.openWeb.hidden = true
        }
        renderHero(article)
        renderArchive()
        updateNavigation()
        requestAnimationFrame(() => {
            elements.scrollable.scrollTop = options.resetScroll === false
                ? (state.readingPositions.get(article.id) || 0)
                : 0
        })
        if(options.focus) elements.title.focus({ preventScroll: true })
        setArchiveOpen(false)
        return true
    }

    function applyFilters(options = {}){
        state.filtered = filterArticles(state.articles, { query: state.query, category: state.category })
        const nextId = selectedArticleId(state.filtered, options.preferredId || state.pendingArticleId, state.selectedId)
        renderCategories()
        if(nextId) selectArticle(nextId, { resetScroll: options.resetScroll !== false, focus: options.focus === true })
        else {
            saveReadingPosition()
            state.selectedId = null
            renderArchive()
            elements.article.hidden = true
            elements.statePanel.hidden = false
            elements.empty.hidden = false
            elements.loading.hidden = true
            elements.failed.hidden = true
        }
    }

    function formatFeedState(result){
        if(result?.offline || result?.cached) return { kind: 'cached', text: copy('cached') }
        return { kind: 'current', text: copy('current') }
    }

    async function load(options = {}){
        if(options.articleId) state.pendingArticleId = options.articleId
        if(state.requestPromise && !options.force) return state.requestPromise
        state.abortController?.abort()
        const abortController = new AbortController()
        state.abortController = abortController
        const sequence = ++state.requestSequence
        if(state.articles.length === 0) setViewState('loading')
        setBadge('loading', copy('checking'))
        elements.refresh.disabled = true

        const request = (async () => {
            try {
                const result = await window.AGNewsFeed.load({
                    force: options.force === true,
                    allowCached: true,
                    signal: abortController.signal
                })
                if(sequence !== state.requestSequence) return result
                state.articles = Array.isArray(result?.articles) ? result.articles : []
                state.cached = result?.cached === true
                state.offline = result?.offline === true
                const feedState = formatFeedState(result)
                setBadge(feedState.kind, feedState.text)
                if(state.articles.length === 0){
                    state.filtered = []
                    renderCategories()
                    renderArchive()
                    setViewState('empty')
                    return result
                }
                setViewState('ready')
                applyFilters({ preferredId: state.pendingArticleId, resetScroll: false })
                return result
            } catch(error){
                if(sequence !== state.requestSequence) return null
                if(error?.name === 'AbortError') return null
                if(state.articles.length){
                    setBadge('error', copy('unavailable'))
                    setViewState('ready')
                } else {
                    setBadge('error', copy('unavailable'))
                    setViewState('error')
                }
                throw error
            } finally {
                if(sequence === state.requestSequence){
                    elements.refresh.disabled = false
                    state.requestPromise = null
                    state.abortController = null
                }
            }
        })()
        state.requestPromise = request
        return request
    }

    async function activate(options = {}){
        state.active = true
        if(options.articleId) state.pendingArticleId = options.articleId
        if(state.articles.length && !options.force){
            setViewState('ready')
            applyFilters({ preferredId: state.pendingArticleId, resetScroll: false, focus: options.focus === true })
            return { articles: state.articles, cached: state.cached, offline: state.offline }
        }
        return load(options)
    }

    function deactivate(options = {}){
        state.active = false
        saveReadingPosition()
        setArchiveOpen(false)
        state.abortController?.abort()
        state.abortController = null
        state.requestPromise = null
        state.requestSequence += 1
        if(options.restoreFocus && (state.returnFocus || state.returnFocusNewsId)){
            const originalTarget = state.returnFocus
            const newsId = state.returnFocusNewsId
            state.returnFocus = null
            state.returnFocusNewsId = null
            requestAnimationFrame(() => {
                const replacement = newsId
                    ? Array.from(document.querySelectorAll('[data-news-id]')).find(element => element.dataset.newsId === newsId)
                    : null
                const target = replacement || (originalTarget?.isConnected ? originalTarget : null)
                target?.focus({ preventScroll: true })
            })
        } else if(options.clearReturnFocus){
            state.returnFocus = null
            state.returnFocusNewsId = null
        }
    }

    function navigate(direction){
        const id = adjacentArticleId(state.filtered, state.selectedId, direction)
        if(id) selectArticle(id, { focus: true })
    }

    elements.search.addEventListener('input', () => {
        state.query = elements.search.value
        applyFilters({ resetScroll: false })
    })
    elements.categories.addEventListener('click', event => {
        const button = event.target.closest('[data-news-category]')
        if(!button) return
        state.category = button.dataset.newsCategory
        applyFilters({ resetScroll: false })
    })
    elements.archiveList.addEventListener('click', event => {
        const button = event.target.closest('[data-news-article-id]')
        if(button) selectArticle(button.dataset.newsArticleId, { focus: true })
    })
    elements.previous.addEventListener('click', () => navigate(-1))
    elements.next.addEventListener('click', () => navigate(1))
    elements.refresh.addEventListener('click', () => load({ force: true }).catch(error => loggerLanding.warn('Unable to refresh News.', error)))
    elements.retry.addEventListener('click', () => load({ force: true }).catch(error => loggerLanding.warn('Unable to retry News.', error)))
    elements.archiveToggle.addEventListener('click', () => setArchiveOpen(!state.archiveOpen))
    elements.archiveClose.addEventListener('click', () => setArchiveOpen(false))
    elements.archiveScrim.addEventListener('click', () => setArchiveOpen(false))
    elements.heroImage.addEventListener('error', () => {
        elements.heroImage.hidden = true
        elements.hero.removeAttribute('data-has-image')
    })
    elements.scrollable.addEventListener('scroll', () => {
        if(state.selectedId) state.readingPositions.set(state.selectedId, elements.scrollable.scrollTop)
    }, { passive: true })
    elements.archiveNavigation.addEventListener('scroll', () => {
        state.archiveScrollTop = elements.archiveNavigation.scrollTop
    }, { passive: true })
    root.addEventListener('keydown', event => {
        if(event.key === 'Escape' && state.archiveOpen){
            event.preventDefault()
            setArchiveOpen(false)
            elements.archiveToggle.focus()
        }
    })
    window.addEventListener('helios:shell-route-change', event => {
        if(event.detail?.route === 'news') activate().catch(error => loggerLanding.warn('Unable to activate News.', error))
        else deactivate({
            restoreFocus: event.detail?.route === 'home',
            clearReturnFocus: event.detail?.route !== 'home'
        })
    })

    return {
        activate,
        deactivate,
        load,
        refresh: () => load({ force: true }),
        openArticle: (articleId, options = {}) => {
            if(options.returnFocus?.isConnected){
                state.returnFocus = options.returnFocus
                state.returnFocusNewsId = options.returnFocus.dataset?.newsId || null
            }
            return activate({ articleId, focus: true })
        },
        getState: () => ({
            active: state.active,
            category: state.category,
            query: state.query,
            selectedId: state.selectedId,
            articleCount: state.articles.length,
            filteredCount: state.filtered.length
        })
    }
}

window.AGNewsView = createNewsView()
