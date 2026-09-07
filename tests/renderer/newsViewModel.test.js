'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
    adjacentArticleId,
    availableCategories,
    filterArticles,
    normalizeSearchText,
    selectedArticleId,
    trustedHeroImage
} = require('../../app/assets/js/newsviewmodel')

const articles = [
    {
        id: 'launcher:2.10',
        title: 'AG Launcher 2.10',
        summary: 'A responsive News workspace.',
        author: 'Allegator Games',
        category: 'launcher-release',
        tags: ['Launcher', 'News'],
        link: 'https://news.allegatorgames.com/news/launcher-2-10/'
    },
    {
        id: 'community:builders',
        title: 'Builder Showcase',
        summary: 'Highlights from creators.',
        author: 'Workshop Team',
        category: 'community',
        tags: ['Schematics']
    },
    {
        id: 'future:status',
        title: 'Service Status',
        summary: 'Maintenance notice.',
        author: 'Operations',
        category: 'status-update',
        tags: []
    }
]

test('News search is case and accent insensitive across normalized metadata', () => {
    assert.equal(normalizeSearchText('  POKÉMON   News '), 'pokemon news')
    assert.deepEqual(filterArticles(articles, { query: 'ALLEGATOR launcher' }).map(article => article.id), ['launcher:2.10'])
    assert.deepEqual(filterArticles(articles, { query: 'schematics' }).map(article => article.id), ['community:builders'])
})

test('News category filters expose represented categories in stable order', () => {
    assert.deepEqual(availableCategories(articles), ['launcher-release', 'community', 'status-update'])
    assert.deepEqual(filterArticles(articles, { category: 'community' }).map(article => article.id), ['community:builders'])
})

test('News selection remains valid after filtering and navigation stops at boundaries', () => {
    assert.equal(selectedArticleId(articles, 'community:builders', 'launcher:2.10'), 'community:builders')
    assert.equal(selectedArticleId(articles, 'missing', 'launcher:2.10'), 'launcher:2.10')
    assert.equal(selectedArticleId(articles, 'missing', 'missing'), 'launcher:2.10')
    assert.equal(adjacentArticleId(articles, 'launcher:2.10', -1), null)
    assert.equal(adjacentArticleId(articles, 'launcher:2.10', 1), 'community:builders')
    assert.equal(adjacentArticleId(articles, 'future:status', 1), null)
})

test('News hero images require HTTPS and the canonical article origin', () => {
    const article = articles[0]
    assert.equal(
        trustedHeroImage({ ...article, heroImage: 'https://news.allegatorgames.com/assets/hero.webp' }),
        'https://news.allegatorgames.com/assets/hero.webp'
    )
    assert.equal(trustedHeroImage({ ...article, heroImage: 'https://cdn.example.test/hero.webp' }), null)
    assert.equal(trustedHeroImage({ ...article, heroImage: 'http://news.allegatorgames.com/hero.webp' }), null)
    assert.equal(trustedHeroImage({ ...article, heroImage: 'not-a-url' }), null)
})
