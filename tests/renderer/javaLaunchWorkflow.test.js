const test = require('node:test')
const assert = require('node:assert/strict')

const { completeJavaSelection } = require('../../app/assets/js/javalaunchworkflow')

test('Java selection does not require the lazy Settings controller', async () => {
    const settingsInput = { value: null }
    const saved = []

    const javaExec = await completeJavaSelection({
        jvmDetails: { path: 'C:\\runtime\\jdk-21' },
        javaExecFromRoot: root => `${root}\\bin\\javaw.exe`,
        serverId: 'Cobble-Power-1.21.1',
        setJavaExecutable: (serverId, executable) => saved.push({ serverId, executable }),
        saveConfig: () => saved.push('saved'),
        settingsInput,
        launchAfter: false
    })

    assert.equal(javaExec, 'C:\\runtime\\jdk-21\\bin\\javaw.exe')
    assert.equal(settingsInput.value, javaExec)
    assert.deepEqual(saved, [
        { serverId: 'Cobble-Power-1.21.1', executable: javaExec },
        'saved'
    ])
})

test('Java selection awaits Settings refresh and game launch', async () => {
    const events = []
    let releaseLaunch
    const launchGate = new Promise(resolve => {
        releaseLaunch = resolve
    })

    const selection = completeJavaSelection({
        jvmDetails: { path: '/runtime/jdk-21' },
        javaExecFromRoot: root => `${root}/bin/java`,
        serverId: 'Cobble-Power-1.21.1',
        setJavaExecutable: () => events.push('configured'),
        saveConfig: () => events.push('saved'),
        populateJavaDetails: async () => events.push('settings-refreshed'),
        launch: async () => {
            events.push('launch-started')
            await launchGate
            events.push('launch-finished')
        }
    })

    let completed = false
    selection.then(() => {
        completed = true
    })
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(completed, false)
    assert.deepEqual(events, ['configured', 'saved', 'settings-refreshed', 'launch-started'])

    releaseLaunch()
    await selection
    assert.equal(completed, true)
    assert.deepEqual(events, ['configured', 'saved', 'settings-refreshed', 'launch-started', 'launch-finished'])
})
