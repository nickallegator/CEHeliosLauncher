const test = require('node:test')
const assert = require('node:assert/strict')

test('renderer smoke (module import only)', (t) => {
    if (process.env.RUN_RENDERER_TESTS !== '1') {
        t.skip('Set RUN_RENDERER_TESTS=1 to enable renderer smoke tests.')
        return
    }

    // This is intentionally light-weight to avoid WebGL/DOM requirements.
    // It ensures shared modules remain importable.
    const core = require('../../libraries/schematics-core')
    assert.equal(typeof core.normalizeJsonSchematic, 'function')
})
