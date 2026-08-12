'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const { buildDependencyTree } = require('../../scripts/npm-list-shim')

test('npm list shim exposes production dependencies to Electron Builder', () => {
    const projectRoot = path.resolve(__dirname, '..', '..')
    const tree = buildDependencyTree(projectRoot)
    assert.equal(tree.name, 'ag-launcher')
    assert.ok(tree.dependencies.jquery)
    assert.ok(tree.dependencies['helios-core'])
    assert.ok(tree.dependencies['@electron/remote'])
    assert.equal(tree.dependencies.electron, undefined)
    assert.equal(tree.dependencies.eslint, undefined)
})
