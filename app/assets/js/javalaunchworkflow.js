/**
 * Complete selection of a validated Java runtime.
 *
 * This module deliberately has no Electron or DOM dependencies so the launch
 * sequence can be tested without loading the renderer.
 */
async function completeJavaSelection({
    jvmDetails,
    javaExecFromRoot,
    serverId,
    setJavaExecutable,
    saveConfig,
    settingsInput = null,
    populateJavaDetails = null,
    launchAfter = true,
    launch
}){
    if(jvmDetails?.path == null){
        throw new Error('Validated Java details must include an installation path.')
    }

    const javaExec = javaExecFromRoot(jvmDetails.path)
    setJavaExecutable(serverId, javaExec)
    saveConfig()

    if(settingsInput != null){
        settingsInput.value = javaExec
    }
    if(typeof populateJavaDetails === 'function'){
        await populateJavaDetails(javaExec)
    }

    if(launchAfter){
        if(typeof launch !== 'function'){
            throw new Error('A launch callback is required when launchAfter is enabled.')
        }
        await launch()
    }

    return javaExec
}

module.exports = {
    completeJavaSelection
}
