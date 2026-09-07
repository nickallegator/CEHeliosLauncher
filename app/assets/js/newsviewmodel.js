'use strict'

const CATEGORY_ORDER = Object.freeze([
    'announcement',
    'launcher-release',
    'mod-release',
    'community',
    'maintenance'
])

function normalizeSearchText(value){
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
}

function articleSearchText(article){
    return normalizeSearchText([
        article?.title,
        article?.summary,
        article?.author,
        article?.category,
        ...(Array.isArray(article?.tags) ? article.tags : [])
    ].filter(Boolean).join(' '))
}

function availableCategories(articles = []){
    const categories = new Set(articles.map(article => normalizeSearchText(article?.category)).filter(Boolean))
    return [
        ...CATEGORY_ORDER.filter(category => categories.delete(category)),
        ...Array.from(categories).sort((left, right) => left.localeCompare(right))
    ]
}

function filterArticles(articles = [], options = {}){
    const query = normalizeSearchText(options.query)
    const queryTerms = query.split(' ').filter(Boolean)
    const category = normalizeSearchText(options.category || 'all') || 'all'
    return articles.filter(article => {
        if(category !== 'all' && normalizeSearchText(article?.category) !== category) return false
        if(queryTerms.length === 0) return true
        const searchText = articleSearchText(article)
        return queryTerms.every(term => searchText.includes(term))
    })
}

function selectedArticleId(articles = [], preferredId = null, currentId = null){
    if(preferredId && articles.some(article => article.id === preferredId)) return preferredId
    if(currentId && articles.some(article => article.id === currentId)) return currentId
    return articles[0]?.id || null
}

function adjacentArticleId(articles = [], currentId, direction){
    const index = articles.findIndex(article => article.id === currentId)
    if(index < 0) return null
    const nextIndex = index + (direction < 0 ? -1 : 1)
    return nextIndex >= 0 && nextIndex < articles.length ? articles[nextIndex].id : null
}

function categoryLabel(category){
    return String(category || 'announcement')
        .split('-')
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ')
}

function trustedHeroImage(article){
    if(!article?.heroImage || !article?.link) return null
    try {
        const hero = new URL(article.heroImage)
        const canonical = new URL(article.link)
        return hero.protocol === 'https:' && hero.origin === canonical.origin ? hero.toString() : null
    } catch (_error){
        return null
    }
}

module.exports = {
    CATEGORY_ORDER,
    adjacentArticleId,
    articleSearchText,
    availableCategories,
    categoryLabel,
    filterArticles,
    normalizeSearchText,
    selectedArticleId,
    trustedHeroImage
}
