function initSchematics(){
    if(!schematicsRouteListenerBound){
        window.addEventListener('helios:shell-route-change', (event) => {
            if(event.detail?.route !== 'community'){
                if(schematicsScroll) schematicsState.scrollTop = schematicsScroll.scrollTop
                cancelSchematicsRouteWork()
            } else if(schematicsScroll){
                requestAnimationFrame(() => { schematicsScroll.scrollTop = schematicsState.scrollTop || 0 })
            }
        })
        schematicsRouteListenerBound = true
    }
    if(!schematicsGrid){
        return
    }

    schematicsGrid.addEventListener('click', (event) => {
        const card = event.target.closest('.schematicCard')
        if(!card){
            return
        }
        const entry = getCommunityEntryByKey(card.getAttribute('data-community-key'))
            || getSchematicById(card.getAttribute('data-schematic-id'))
        if(entry){
            const definition = communityContentRegistry?.get(entry.communityType || 'schematics')
            definition?.openDetail(entry, {
                openSchematicDetail,
                openGenericCommunityDetail: window.openGenericCommunityDetail
            })
        }
    })
    resolveSchematicsServiceConfig().then(() => {
        if(schematicsDetailAddToCollection) schematicsDetailAddToCollection.hidden = true
        if(schematicsUploadVisibility){
            schematicsUploadVisibility.value = 'public'
            schematicsUploadVisibility.disabled = true
            Array.from(schematicsUploadVisibility.options).forEach(option => { option.hidden = option.value !== 'public' })
        }
    }).catch(() => {})
    if(schematicsCreatorGrid){
        schematicsCreatorGrid.addEventListener('click', (event) => {
            const card = event.target.closest('.schematicCard')
            if(!card){
                return
            }
            const entry = getSchematicById(card.getAttribute('data-schematic-id'))
            if(entry){
                closeCreatorPanel()
                openSchematicDetail(entry)
            }
        })
    }
    if(schematicsCollectionsDetailGrid){
        schematicsCollectionsDetailGrid.addEventListener('click', (event) => {
            const card = event.target.closest('.schematicCard')
            if(!card){
                return
            }
            const entry = getSchematicById(card.getAttribute('data-schematic-id'))
            if(entry){
                openSchematicDetail(entry)
            }
        })
    }
    if(schematicsCollectionsBrowseDetailGrid){
        schematicsCollectionsBrowseDetailGrid.addEventListener('click', (event) => {
            const card = event.target.closest('.schematicCard')
            if(!card){
                return
            }
            const entry = getSchematicById(card.getAttribute('data-schematic-id'))
            if(entry){
                closeCollectionsBrowseDetail()
                openSchematicDetail(entry)
            }
        })
    }
    window.addEventListener('resize', scheduleCommunityPageSizeRefresh)
    scheduleCommunityPageSizeRefresh()
    if(schematicsCreatorSort){
        schematicsCreatorSort.addEventListener('change', () => {
            fetchCreatorSchematics(schematicsCreatorState.creator, { page: 1, sortKey: schematicsCreatorSort.value })
        })
    }
    if(schematicsCreatorPagePrev){
        schematicsCreatorPagePrev.addEventListener('click', () => {
            const nextPage = Math.max(1, schematicsCreatorState.page - 1)
            fetchCreatorSchematics(schematicsCreatorState.creator, { page: nextPage })
        })
    }
    if(schematicsCreatorPageNext){
        schematicsCreatorPageNext.addEventListener('click', () => {
            const total = Number.isFinite(Number(schematicsCreatorState.total)) ? Number(schematicsCreatorState.total) : 0
            const pages = Math.max(1, Math.ceil(total / schematicsCreatorState.pageSize))
            const nextPage = Math.min(pages, schematicsCreatorState.page + 1)
            fetchCreatorSchematics(schematicsCreatorState.creator, { page: nextPage })
        })
    }

    if(schematicsDetailClose){
        schematicsDetailClose.addEventListener('click', closeSchematicDetail)
    }
    if(schematicsDetailScrim){
        schematicsDetailScrim.addEventListener('click', closeSchematicDetail)
    }
    if(schematicsAdminToolsButton){
        schematicsAdminToolsButton.addEventListener('click', openSchematicsAdminPanel)
    }
    if(schematicsAdminClose){
        schematicsAdminClose.addEventListener('click', closeSchematicsAdminPanel)
    }
    if(schematicsAdminScrim){
        schematicsAdminScrim.addEventListener('click', closeSchematicsAdminPanel)
    }
    if(schematicsAdminRun){
        schematicsAdminRun.addEventListener('click', runSchematicsAdminRegeneration)
    }
    if(schematicsCreatorClose){
        schematicsCreatorClose.addEventListener('click', closeCreatorPanel)
    }
    setCommunitySection('content', { skipFetch: true })
    if(typeof initGenericCommunityContent === 'function') initGenericCommunityContent()
    setCommunityCategory(schematicsState.category || 'all', { skipFetch: true })
    communityCategoryFilters?.addEventListener('click', (event) => {
        const button = event.target.closest('[data-community-category]')
        if(button && !button.hidden) setCommunityCategory(button.dataset.communityCategory)
    })
    if(schematicsCollectionsSearchInput){
        schematicsCollectionsSearchInput.addEventListener('input', scheduleCollectionsBrowseFetch)
    }
    if(schematicsCollectionsFilterToggle){
        schematicsCollectionsFilterToggle.addEventListener('click', () => {
            if(schematicsCollectionsFiltersPanel){
                schematicsCollectionsFiltersPanel.hidden = !schematicsCollectionsFiltersPanel.hidden
            }
        })
    }
    if(schematicsCollectionsFiltersClose){
        schematicsCollectionsFiltersClose.addEventListener('click', () => {
            if(schematicsCollectionsFiltersPanel){
                schematicsCollectionsFiltersPanel.hidden = true
            }
        })
    }
    if(schematicsCollectionsCreatorInput){
        schematicsCollectionsCreatorInput.addEventListener('input', scheduleCollectionsBrowseFetch)
    }
    if(schematicsCollectionsSortSelect){
        schematicsCollectionsSortSelect.addEventListener('change', () => fetchCollectionsBrowse({ page: 1, sort: schematicsCollectionsSortSelect.value }))
    }
    if(schematicsCollectionsMineToggle){
        schematicsCollectionsMineToggle.addEventListener('change', () => fetchCollectionsBrowse({ page: 1, mine: schematicsCollectionsMineToggle.checked }))
    }
    if(schematicsCollectionsCreateButton){
        schematicsCollectionsCreateButton.addEventListener('click', openCollectionsCreatePanel)
    }
    if(schematicsCollectionsBrowseDetailBack){
        schematicsCollectionsBrowseDetailBack.addEventListener('click', closeCollectionsBrowseDetail)
    }
    if(schematicsCollectionsBrowseDetailLike){
        schematicsCollectionsBrowseDetailLike.addEventListener('click', () => {
            const entry = schematicsCollectionsBrowseState?.detail
            if(entry){
                toggleCollectionLike(entry)
            }
        })
    }
    if(schematicsCollectionsBrowseDetailScrim){
        schematicsCollectionsBrowseDetailScrim.addEventListener('click', closeCollectionsBrowseDetail)
    }
    if(schematicsCollectionsPagePrev){
        schematicsCollectionsPagePrev.addEventListener('click', () => {
            const nextPage = Math.max(1, schematicsCollectionsBrowseState.page - 1)
            fetchCollectionsBrowse({ page: nextPage })
        })
    }
    if(schematicsCollectionsPageNext){
        schematicsCollectionsPageNext.addEventListener('click', () => {
            const total = Number.isFinite(Number(schematicsCollectionsBrowseState.total)) ? Number(schematicsCollectionsBrowseState.total) : 0
            const pages = Math.max(1, Math.ceil(total / schematicsCollectionsBrowseState.pageSize))
            const nextPage = Math.min(pages, schematicsCollectionsBrowseState.page + 1)
            fetchCollectionsBrowse({ page: nextPage })
        })
    }
    if(schematicsCollectionsScrim){
        schematicsCollectionsScrim.addEventListener('click', closeCollectionsPanel)
    }
    if(schematicsCollectionsClose){
        schematicsCollectionsClose.addEventListener('click', closeCollectionsPanel)
    }
    if(schematicsCollectionsTabPublic){
        schematicsCollectionsTabPublic.addEventListener('click', () => openCollectionsPanel('public'))
    }
    if(schematicsCollectionsTabMine){
        schematicsCollectionsTabMine.addEventListener('click', () => openCollectionsPanel('mine'))
    }
    if(schematicsCollectionsNew){
        schematicsCollectionsNew.addEventListener('click', () => {
            if(schematicsCollectionsCreate){
                schematicsCollectionsCreate.hidden = false
            }
        })
    }
    if(schematicsCollectionsCreateCancel){
        schematicsCollectionsCreateCancel.addEventListener('click', () => {
            if(schematicsCollectionsCreate){
                schematicsCollectionsCreate.hidden = true
            }
        })
    }
    if(schematicsCollectionsCreateSave){
        schematicsCollectionsCreateSave.addEventListener('click', createCollection)
    }
    if(schematicsCollectionsDetailBack){
        schematicsCollectionsDetailBack.addEventListener('click', () => {
            schematicsCollectionsState = {
                ...schematicsCollectionsState,
                view: 'list',
                detail: null
            }
            renderCollectionsPanel()
        })
    }
    if(schematicsCollectionsDetailDelete){
        schematicsCollectionsDetailDelete.addEventListener('click', () => {
            const id = schematicsCollectionsState.detail?.id
            if(id){
                deleteCollectionById(id)
            }
        })
    }
    document.addEventListener('keydown', (event) => {
        if(event.key === 'F10'){
            toggleSchematicsHitDebug()
            return
        }
        if(event.key !== 'Escape'){
            return
        }
        if(communityPublishPicker?.getAttribute('data-open') === 'true'){
            closeCommunityPublishPicker()
            return
        }
        if(schematicsEditOpen){
            closeSchematicEdit()
            return
        }
        if(schematicDetailOpen){
            closeSchematicDetail()
        }
        if(schematicsCreatorOpen){
            closeCreatorPanel()
        }
        if(schematicsCollectionsBrowseDetailOpen){
            closeCollectionsBrowseDetail()
        }
        if(schematicsCollectionsOpen){
            closeCollectionsPanel()
        }
        if(schematicsUploadOpen){
            closeSchematicUpload()
        }
        if(schematicsInstalledOpen){
            closeInstalledPanel()
        }
        if(schematicsAdminOpen){
            closeSchematicsAdminPanel()
        }
    })

    if(schematicsSortSelect){
        schematicsSortSelect.value = SCHEMATICS_SORT_DEFAULT
        schematicsSortSelect.addEventListener('change', () => {
            fetchSchematicsList({ query: schematicsSearchInput?.value || '', sortKey: schematicsSortSelect.value, page: 1 })
        })
    }
    if(schematicsContent){
        schematicsContent.addEventListener('click', (event) => {
            if(!schematicsHitDebugEnabled){
                return
            }
            const target = event.target
            const pointEl = document.elementFromPoint(event.clientX, event.clientY)
            const path = (event.composedPath && event.composedPath()) || []
            const brief = (el) => {
                if(!el || el === window || el === document){
                    return String(el)
                }
                const id = el.id ? `#${el.id}` : ''
                const cls = el.classList && el.classList.length ? `.${[...el.classList].slice(0, 2).join('.')}` : ''
                return `${el.tagName?.toLowerCase() || 'el'}${id}${cls}`
            }
            loggerLanding.warn('[SchematicsHitDebug] click', {
                target: brief(target),
                elementFromPoint: brief(pointEl),
                path: path.slice(0, 6).map(brief)
            })
        }, true)
    }
    if(schematicsSearchInput){
        schematicsSearchInput.addEventListener('input', scheduleSchematicsFetch)
    }
    if(schematicsFilterToggle){
        schematicsFilterToggle.addEventListener('click', () => {
            if(schematicsFiltersPanel){
                schematicsFiltersPanel.hidden = !schematicsFiltersPanel.hidden
            }
        })
    }
    if(schematicsFiltersClose){
        schematicsFiltersClose.addEventListener('click', () => {
            if(schematicsFiltersPanel){
                schematicsFiltersPanel.hidden = true
            }
        })
    }
    if(schematicsTagsInput){
        schematicsTagsInput.addEventListener('input', scheduleSchematicsFetch)
    }
    if(schematicsCreatorInput){
        schematicsCreatorInput.addEventListener('input', scheduleSchematicsFetch)
    }
    if(schematicsInstalledToggle){
        schematicsInstalledToggle.addEventListener('change', renderSchematics)
    }
    if(schematicsMineToggle){
        schematicsMineToggle.addEventListener('change', () => {
            fetchSchematicsList({ query: schematicsSearchInput?.value || '', sortKey: schematicsSortSelect?.value || SCHEMATICS_SORT_DEFAULT, page: 1 })
        })
    }
    if(schematicsOpenFolderButton){
        schematicsOpenFolderButton.addEventListener('click', async () => {
            try {
                const { shell } = require('electron')
                const context = await resolveSchematicInstallContext()
                const directory = schematicsInstallManager.directory(context.profileId, context.account.uuid)
                await fs.ensureDir(directory)
                shell.openPath(directory)
            } catch (err) {
                loggerLanding.warn('Failed to open schematics folder.', err)
            }
        })
    }
    if(schematicsManageInstalledButton){
        schematicsManageInstalledButton.addEventListener('click', openInstalledPanel)
    }
    if(schematicsInstalledClose){
        schematicsInstalledClose.addEventListener('click', closeInstalledPanel)
    }
    if(schematicsInstalledScrim){
        schematicsInstalledScrim.addEventListener('click', closeInstalledPanel)
    }
    if(schematicsUploadButton){
        schematicsUploadButton.addEventListener('click', openCommunityPublisher)
    }
    communityPublishPickerClose?.addEventListener('click', closeCommunityPublishPicker)
    communityPublishPickerScrim?.addEventListener('click', closeCommunityPublishPicker)
    if(schematicsUploadClose){
        schematicsUploadClose.addEventListener('click', closeSchematicUpload)
    }
    if(schematicsUploadScrim){
        schematicsUploadScrim.addEventListener('click', closeSchematicUpload)
    }
    if(schematicsUploadInput){
        schematicsUploadInput.addEventListener('change', (event) => {
            const file = event.target.files?.[0]
            handleSchematicUploadFile(file)
        })
    }
    if(schematicsUploadDropzone){
        schematicsUploadDropzone.addEventListener('dragover', (event) => {
            event.preventDefault()
            schematicsUploadDropzone.setAttribute('data-drag', 'true')
        })
        schematicsUploadDropzone.addEventListener('dragleave', () => {
            schematicsUploadDropzone.removeAttribute('data-drag')
        })
        schematicsUploadDropzone.addEventListener('drop', (event) => {
            event.preventDefault()
            schematicsUploadDropzone.removeAttribute('data-drag')
            const file = event.dataTransfer?.files?.[0]
            if(file){
                handleSchematicUploadFile(file)
            }
        })
        schematicsUploadDropzone.addEventListener('keydown', (event) => {
            if(event.key === 'Enter' || event.key === ' '){
                event.preventDefault()
                schematicsUploadInput?.click()
            }
        })
    }
    if(schematicsUploadSubmit){
        schematicsUploadSubmit.addEventListener('click', submitSchematicUploadV2)
    }
    if(schematicsEditClose){
        schematicsEditClose.addEventListener('click', closeSchematicEdit)
    }
    if(schematicsEditScrim){
        schematicsEditScrim.addEventListener('click', closeSchematicEdit)
    }
    if(schematicsEditCancel){
        schematicsEditCancel.addEventListener('click', closeSchematicEdit)
    }
    if(schematicsEditSubmit){
        schematicsEditSubmit.addEventListener('click', submitSchematicEdit)
    }
    if(schematicsEditRevision){
        schematicsEditRevision.addEventListener('click', openSchematicRevisionUpload)
    }
    communityLoadMoreButton?.addEventListener('click', () => fetchSchematicsList({ append: true }))
    schematicsScroll?.addEventListener('scroll', scheduleCommunityProgressiveLoad, { passive: true })
    if(communityLoadSentinel && 'IntersectionObserver' in window){
        const observer = new IntersectionObserver((entries) => {
            if(entries.some(entry => entry.isIntersecting) && schematicsActive && schematicsState.nextCursor){
                fetchSchematicsList({ append: true })
            }
        }, { root: schematicsScroll || null, rootMargin: '240px 0px' })
        observer.observe(communityLoadSentinel)
    }

    updateSchematicsAdminVisibility()
    loadSchematicsInstallIndex()
        .finally(() => {
            fetchSchematicsList({ query: schematicsSearchInput?.value || '', sortKey: SCHEMATICS_SORT_DEFAULT, page: 1 })
        })
    renderSchematics()

}

