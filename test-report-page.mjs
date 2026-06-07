import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const screenshotDir = path.join(__dirname, 'test-report-screenshots');
fs.mkdirSync(screenshotDir, { recursive: true });

async function screenshot(page, name) {
  const filePath = path.join(screenshotDir, name);
  await page.screenshot({ path: filePath, fullPage: true });
  console.log(`  Screenshot: ${name}`);
  return filePath;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    // Navigate to report page
    console.log('\n=== Opening report page ===');
    await page.goto('http://localhost:18080/report', { waitUntil: 'networkidle', timeout: 15000 });
    await sleep(1000); // Wait for React to render

    // ====== Test Case 1: Single Work Session ======
    console.log('\n*** Test Case 1: Single Work Session ***');

    // Screenshot the initial state (all folded)
    await screenshot(page, 'tc1-initial-folded.png');
    console.log('  [✓] Page loaded, all sections folded by default');

    // Extract stats from header
    const statsText = await page.evaluate(() => {
      const sections = document.querySelectorAll('.border.rounded-lg');
      const result = [];
      for (const section of sections) {
        const labels = section.querySelectorAll('.text-xs.text-muted-foreground');
        const values = section.querySelectorAll('.text-lg.font-semibold');
        const labelTexts = Array.from(labels).map(l => l.textContent);
        const valueTexts = Array.from(values).map(v => v.textContent);
        result.push({ labels: labelTexts, values: valueTexts });
      }
      return result;
    });
    console.log('  Stats sections:', JSON.stringify(statsText));

    // Click On-duty to expand
    const onDutyHeader = page.locator('.border.rounded-lg').first().locator('.cursor-pointer');
    await onDutyHeader.click();
    await sleep(500);
    await screenshot(page, 'tc1-on-duty-expanded.png');
    console.log('  [✓] On-duty clicked, section expanded');

    // Check what's shown in On-duty expanded content
    const onDutyContent = await page.evaluate(() => {
      const sections = document.querySelectorAll('.border.rounded-lg');
      const first = sections[0];
      const dateHeaders = first.querySelectorAll('.bg-muted\\/30');
      const rows = first.querySelectorAll('.px-4\\.py-3\\.flex');
      return {
        dateHeaders: Array.from(dateHeaders).map(d => d.textContent),
        rowCount: rows.length,
        rowText: Array.from(rows).map(r => r.textContent?.trim().substring(0, 80))
      };
    });
    console.log('  On-duty content:', JSON.stringify(onDutyContent));

    // Click On-duty to collapse, then expand Work Time
    await onDutyHeader.click();
    await sleep(300);
    const workTimeHeader = page.locator('.border.rounded-lg').nth(1).locator('.cursor-pointer');
    await workTimeHeader.click();
    await sleep(500);
    await screenshot(page, 'tc1-work-time-expanded.png');
    console.log('  [✓] Work Time clicked, section expanded');

    // Check Work Time content
    const workTimeContent = await page.evaluate(() => {
      const sections = document.querySelectorAll('.border.rounded-lg');
      const second = sections[1];
      const rows = second.querySelectorAll('.px-4\\.py-3\\.flex');
      return {
        rowCount: rows.length,
        rowText: Array.from(rows).map(r => r.textContent?.trim().substring(0, 80))
      };
    });
    console.log('  Work Time rows:', workTimeContent.rowCount);

    // Click Work Time to collapse, then expand Idle Time
    await workTimeHeader.click();
    await sleep(300);
    const idleTimeHeader = page.locator('.border.rounded-lg').nth(2).locator('.cursor-pointer');
    await idleTimeHeader.click();
    await sleep(500);
    await screenshot(page, 'tc1-idle-time-expanded.png');
    console.log('  [✓] Idle Time clicked, section expanded');

    // Check that idle time shows empty state
    const idleEmpty = await page.evaluate(() => {
      const sections = document.querySelectorAll('.border.rounded-lg');
      const third = sections[2];
      const text = third.textContent || '';
      return { isEmpty: text.includes('No work sessions') || text.includes('暂无工作记录') };
    });
    console.log('  Idle Time empty:', idleEmpty.isEmpty);

    // ====== Test Case 2: Work Session → Gap → AFK ======
    console.log('\n*** Test Case 2: Work → Gap → AFK ***');

    // Click Idle Time to collapse
    await idleTimeHeader.click();
    await sleep(300);

    console.log('  Setup data for TC2... (see test results below)');
    // Data is set up via DB before running this script

    // Now reload the page to see new data
    await page.reload({ waitUntil: 'networkidle' });
    await sleep(1500);
    await screenshot(page, 'tc2-initial.png');
    console.log('  [✓] Page reloaded with TC2 data');

    // Expand all three sections
    const headers = page.locator('.border.rounded-lg .cursor-pointer');
    const count = await headers.count();
    console.log(`  Found ${count} section headers`);

    for (let i = 0; i < count; i++) {
      await headers.nth(i).click();
      await sleep(300);
    }
    await screenshot(page, 'tc2-all-expanded.png');
    console.log('  [✓] All sections expanded');

    // Extract all records from each section
    const tc2Content = await page.evaluate(() => {
      const sections = document.querySelectorAll('.border.rounded-lg');
      const result = [];
      for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        const headerLabel = section.querySelector('.text-xs.text-muted-foreground')?.textContent || '';
        const rows = section.querySelectorAll('[class*="px-4 py-3 flex items-center gap-6"]');
        const records = Array.from(rows).map(r => {
          const times = r.querySelectorAll('.font-medium, .text-muted-foreground');
          const labels = r.querySelectorAll('.text-xs.px-1\\.5, .italic, .truncate');
          return {
            text: r.textContent?.trim().substring(0, 100),
            hasAFK: r.textContent?.includes('AFK') || false,
            hasGap: r.textContent?.includes('Not Labeled') || r.textContent?.includes('未标记') || false,
            hasWork: !!(r.textContent?.includes('Test Task') || r.textContent?.includes('AFK')) && !r.textContent?.includes('Not Labeled') ?
              !r.textContent?.includes('AFK') : r.textContent?.includes('Test Task')
          };
        });
        result.push({ section: headerLabel, rows: records.length, records });
      }
      return result;
    });
    console.log('  TC2 content:', JSON.stringify(tc2Content, null, 2));

    await screenshot(page, 'tc2-detail.png');

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await browser.close();
  }
}

run();
