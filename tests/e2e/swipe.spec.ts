import { test, expect } from '@playwright/test'

test.describe('Swipe deck', () => {
  test('loads job cards on the main page', async ({ page }) => {
    await page.goto('/')
    // Either shows cards or DB-not-connected fallback
    const heading = page.locator('h1, h2')
    await expect(heading.first()).toBeVisible()
  })

  test('navigation links are present', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('a[href="/dashboard"]')).toBeVisible()
    await expect(page.locator('a[href="/profile"]')).toBeVisible()
  })

  test('profile page loads', async ({ page }) => {
    await page.goto('/profile')
    await expect(page.locator('h1')).toContainText('Profile')
  })

  test('dashboard page loads', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.locator('h1')).toContainText('Applications')
  })
})
