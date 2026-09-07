'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { DOMParser } = require('@xmldom/xmldom')

const {
    NEWS_CACHE_LIMIT,
    NewsFeedRepository,
    parseNewsJson,
    parseRssXml,
    sanitizeArticleHtml,
    stableArticleId,
    stripArticleMarkup
} = require('../../app/assets/js/newsfeedrepository')
const {
    HomeFeedCoordinator,
    normalizeHomeCommunityEntries,
    primaryEngagement
} = require('../../app/assets/js/homefeedmanager')

const RSS = `<?xml version="1.0"?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <item>
      <guid>news-one</guid>
      <title>Workshop &amp; Community</title>
      <link>https://news.example.test/posts/one</link>
      <dc:creator>Allegator Games</dc:creator>
      <pubDate>Sun, 06 Sep 2026 16:30:00 GMT</pubDate>
      <content:encoded><![CDATA[<h2>Ready</h2><p>Safe <strong>news</strong>.</p><script>alert(1)</script>]]></content:encoded>
    </item>
  </channel>
</rss>`

test('News normalization produces stable safe summaries and bounded article data', () => {
    const articles = parseRssXml(RSS, { DOMParser, sourceUrl: 'https://news.example.test/feed.xml' })
    assert.equal(articles.length, 1)
    assert.equal(articles[0].id, stableArticleId('news-one'))
    assert.equal(articles[0].title, 'Workshop & Community')
    assert.equal(articles[0].summary, 'Ready\nSafe news.')
    assert.match(articles[0].content, /<strong>news<\/strong>/)
    assert.doesNotMatch(articles[0].content, /script|alert/)
    assert.equal(stripArticleMarkup('<p>Hello&nbsp;<b>builder</b></p>'), 'Hello builder')
    assert.doesNotMatch(sanitizeArticleHtml('<a href="javascript:alert(1)">bad</a><img src="file:///secret">'), /javascript|file:/)
})

test('News repository coalesces identical requests and falls back to presentation-safe cache', async () => {
    let requests = 0
    let cache = null
    const repository = new NewsFeedRepository({
        fetchText: async () => {
            requests += 1
            await new Promise(resolve => setTimeout(resolve, 5))
            return RSS
        },
        parseXml: (value, context) => parseRssXml(value, { ...context, DOMParser }),
        readCache: () => cache,
        writeCache: value => { cache = value }
    })
    const [first, second] = await Promise.all([
        repository.load({ url: 'https://news.example.test/feed.xml' }),
        repository.load({ url: 'https://news.example.test/feed.xml' })
    ])
    assert.equal(requests, 1)
    assert.deepEqual(first.articles, second.articles)
    assert.equal(cache.articles.length, 1)
    assert.match(cache.articles[0].content, /<strong>news<\/strong>/)

    const offline = new NewsFeedRepository({
        fetchText: async () => { throw new Error('offline') },
        readCache: () => cache
    })
    const cached = await offline.load({ url: 'https://news.example.test/feed.xml', allowCached: true })
    assert.equal(cached.offline, true)
    assert.equal(cached.cached, true)
})

test('News repository prefers schema-versioned JSON, revalidates by ETag, and falls back to RSS', async () => {
    const json = JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-09-07T07:00:00.000Z',
        items: [{
            id: 'announcement:one',
            title: 'JSON News',
            summary: 'A safe summary.',
            author: 'Allegator Games',
            category: 'announcement',
            tags: ['launcher'],
            publishedAt: '2026-09-07T07:00:00.000Z',
            canonicalUrl: 'https://news.example.test/news/json-news/',
            contentHtml: '<p>JSON <strong>content</strong>.</p><script>bad()</script>'
        }]
    })
    const calls = []
    let cache = null
    const repository = new NewsFeedRepository({
        fetchResource: async (url, request) => {
            calls.push([url, request.headers])
            return { statusCode: 200, body: json, headers: { etag: '"news-one"' } }
        },
        readCache: () => cache,
        writeCache: value => { cache = value }
    })
    const result = await repository.load({
        indexUrl: 'https://news.example.test/api/v1/news.json',
        rssUrl: 'https://news.example.test/rss.xml'
    })
    assert.equal(result.articles[0].title, 'JSON News')
    assert.doesNotMatch(result.articles[0].content, /script|bad/)
    assert.equal(calls.length, 1)
    assert.equal(cache.etag, '"news-one"')

    const fallback = new NewsFeedRepository({
        fetchResource: async url => {
            if(url.endsWith('.json')) throw new Error('JSON unavailable')
            return { statusCode: 200, body: RSS, headers: {} }
        },
        parseXml: (value, context) => parseRssXml(value, { ...context, DOMParser })
    })
    const legacy = await fallback.load({
        indexUrl: 'https://news.example.test/api/v1/news.json',
        rssUrl: 'https://news.example.test/rss.xml'
    })
    assert.equal(legacy.articles[0].title, 'Workshop & Community')
})

test('News JSON validation rejects unsupported schemas and unsafe content', () => {
    assert.throws(() => parseNewsJson('{"schemaVersion":2,"items":[]}'), /unsupported schema/)
    assert.throws(() => parseNewsJson(JSON.stringify({ schemaVersion: 1, items: [{ id: 'missing-fields' }] })), /incomplete/)
})

test('News caches remain bounded to ten entries', async () => {
    const item = index => `<item><guid>${index}</guid><title>${index}</title><link>https://news.example.test/${index}</link><description>Article ${index}</description></item>`
    const articles = parseRssXml(`<rss><channel>${Array.from({ length: 14 }, (_, index) => item(index)).join('')}</channel></rss>`, { DOMParser })
    assert.equal(articles.length, NEWS_CACHE_LIMIT)
})

test('Home Community normalization filters capabilities, unknown types, and duplicates', () => {
    const definitions = [{
        id: 'schematics',
        normalize: entry => entry.type === 'schematics' ? { id: entry.id, communityKey: `schematics:${entry.id}`, likes: entry.stats.likes } : null
    }]
    const entries = normalizeHomeCommunityEntries([
        { type: 'schematics', id: 'one', stats: { likes: 8 } },
        { type: 'schematics', id: 'one', stats: { likes: 8 } },
        { type: 'future-content', id: 'hidden', stats: { likes: 99 } },
        { type: 'schematics', id: 'two', stats: { likes: 2 } }
    ], definitions)
    assert.deepEqual(entries.map(entry => entry.communityKey), ['schematics:one', 'schematics:two'])
    assert.deepEqual(primaryEngagement(entries[0]), { kind: 'likes', value: 8 })
    assert.deepEqual(primaryEngagement({ downloads: 3 }), { kind: 'downloads', value: 3 })
})

test('Home feed coordinator keeps services independent and discards results after navigation', async () => {
    const events = []
    let resolveNews
    const coordinator = new HomeFeedCoordinator({
        newsLoader: () => new Promise(resolve => { resolveNews = resolve }),
        communityLoader: async () => { throw new Error('community unavailable') },
        renderNews: state => events.push(['news', state.status]),
        renderCommunity: state => events.push(['community', state.status]),
        setInterval: () => 1,
        clearInterval: () => {}
    })
    const activation = coordinator.activate()
    while(typeof resolveNews !== 'function') await new Promise(resolve => setImmediate(resolve))
    coordinator.deactivate()
    resolveNews({ articles: [{ id: 'late' }] })
    await activation
    assert.deepEqual(events, [
        ['news', 'loading'],
        ['community', 'loading'],
        ['community', 'error']
    ])
})
