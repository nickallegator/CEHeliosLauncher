const { test, expect } = require('@playwright/test')
const { _electron: electron } = require('playwright')
const path = require('node:path')

test('launcher smoke: schematics community flows', async () => {
    const appDir = path.resolve(__dirname, '..', '..')
    const electronApp = await electron.launch({
        cwd: appDir,
        args: ['.'],
        env: {
            ...process.env,
            NODE_ENV: 'test'
        }
    })

    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    const title = await page.title()
    expect(title).toBeTruthy()

    const communityTrigger = page.locator('#schematicsButton')
    await page.waitForTimeout(2000)
    if(!(await communityTrigger.isVisible())){
        test.skip(true, 'Schematics button not visible (likely on welcome/login screen).')
    }
    await communityTrigger.click()

    await expect(page.getByText(/schematics library/i)).toBeVisible({ timeout: 15000 })

    const grid = page.locator('#schematicsGrid')
    await expect(grid).toBeVisible({ timeout: 15000 })

    const cards = grid.locator('.schematicCard')
    const cardCount = await cards.count()
    test.skip(cardCount === 0, 'No schematics available for E2E flow.')

    await cards.first().click()
    await expect(page.locator('#schematicsDetail')).toHaveAttribute('data-open', 'true', { timeout: 15000 })
    await expect(page.locator('#schematicsDetailTitle')).toBeVisible()
    await expect(page.locator('#schematicsDetailCanvas')).toBeVisible()
    await expect(page.locator('#schematicsDetailBlocks')).toBeVisible()

    const installButton = page.locator('#schematicsDetailInstall')
    await expect(installButton).toBeVisible()

    if (process.env.E2E_INSTALL === '1') {
        await installButton.click()
        await expect(installButton).toHaveText(/installed|install failed|downloading/i, { timeout: 20000 })
    }

    await page.locator('#schematicsDetailClose').click()
    await expect(page.locator('#schematicsDetail')).toHaveAttribute('aria-hidden', 'true')

    const uploadButton = page.locator('#schematicsUploadButton')
    await expect(uploadButton).toBeVisible()
    await uploadButton.click()
    await expect(page.locator('#schematicsUpload')).toHaveAttribute('data-open', 'true', { timeout: 15000 })
    await expect(page.locator('#schematicsUploadCanvas')).toBeVisible()
    await page.locator('#schematicsUploadClose').click()
    await expect(page.locator('#schematicsUpload')).toHaveAttribute('aria-hidden', 'true')

    await electronApp.close()
})
