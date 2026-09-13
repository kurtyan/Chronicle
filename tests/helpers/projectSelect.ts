import { expect, type Page } from '@playwright/test'

/** Operate the searchable project selector as a user; no direct state changes. */
export async function selectProjectOption(page: Page, label: string, optionText: string) {
  const trigger = page.getByRole('button', { name: label, exact: true }).last()
  await trigger.click()
  const popup = page.locator('[data-project-select-popup]').last()
  await popup.getByRole('combobox').fill(optionText)
  await popup.getByRole('option').filter({ has: page.getByText(optionText, { exact: true }) }).click()
  await expect(popup).not.toBeVisible()
}
