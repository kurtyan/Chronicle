import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const screenshotDir = path.join(__dirname, 'test-report-screenshots');
fs.mkdirSync(screenshotDir, { recursive: true });

async function shot(page, name) {
  const fp = path.join(screenshotDir, name);
  await page.screenshot({ path: fp, fullPage: true });
  console.log(`  [shot] ${name}`);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    await page.goto('http://localhost:18081/report', { waitUntil: 'load', timeout: 15000 });
    await sleep(2000);

    console.log('--- Page loaded ---');
    await shot(page, '00-initial.png');

    // Read all text from first 3 bordered sections
    const raw = await page.evaluate(() => {
      const sections = document.querySelectorAll('.border.rounded-lg');
      const results = [];
      for (let i = 0; i < sections.length; i++) {
        const s = sections[i];
        const headerEls = s.querySelectorAll('.text-xs.text-muted-foreground');
        const valueEls = s.querySelectorAll('.text-lg.font-semibold');
        const labels = Array.from(headerEls).map(e => e.textContent);
        const values = Array.from(valueEls).map(e => e.textContent);
        results.push({ labels, values, fullText: s.textContent.trim().substring(0, 500) });
      }
      return results;
    });

    raw.forEach((r, i) => {
      console.log(`Section ${i}: labels=${JSON.stringify(r.labels)}, values=${JSON.stringify(r.values)}`);
    });

    // Verify: stats should show onDuty=2h, workTime=2h, idleTime=0h
    console.log('\n--- Verifying stats ---');
    const stats = raw.map(r => `${r.labels[0]}: ${r.values[0]}`).join(', ');
    console.log(`Stats: ${stats}`);

    // Click all 3 headers
    for (let i = 0; i < 3; i++) {
      const headers = page.locator('.border.rounded-lg').nth(i).locator('div').first();
      // Find clickable element - the cursor-pointer div inside each section
      const clickable = page.locator('.border.rounded-lg').nth(i).locator('.cursor-pointer');
      const exists = await clickable.count();
      if (exists > 0) {
        await clickable.click();
        await sleep(400);
        console.log(`Clicked section ${i}`);
      }
    }

    await shot(page, '01-all-expanded.png');

    // Get expanded content for each section
    const expanded = await page.evaluate(() => {
      const sections = document.querySelectorAll('.border.rounded-lg');
      const results = [];
      for (let i = 0; i < sections.length; i++) {
        const s = sections[i];
        const text = s.textContent.trim();
        // Check if expanded (has date groups or rows)
        const dateHeaders = s.querySelectorAll('.bg-muted\\/30');
        const dateTexts = Array.from(dateHeaders).map(d => d.textContent.trim());
        // Find all rows: divs that contain time info like "09:00"
        const allDivs = s.querySelectorAll('div');
        const rowTexts = [];
        for (const div of allDivs) {
          const t = div.textContent.trim();
          if (/^\d{2}:\d{2}/.test(t) && !div.closest('.bg-muted\\/30')) {
            rowTexts.push(t);
          }
        }
        results.push({
          dateHeaders: dateTexts,
          rows: rowTexts.slice(0, 10),
          isEmpty: text.includes('暂无工作记录') || text.includes('No work sessions')
        });
      }
      return results;
    });

    console.log('\n--- Expanded content ---');
    expanded.forEach((e, i) => {
      console.log(`Section ${i}:${e.isEmpty ? ' (empty)' : ''}`);
      if (e.dateHeaders.length) console.log(`  Dates: ${e.dateHeaders.join(', ')}`);
      e.rows.slice(0, 5).forEach(r => console.log(`  Row: ${r}`));
    });

    // Verify TC1 expected results
    console.log('\n=== TC1 VERIFICATION ===');
    const tc1OnDuty = expanded[0];
    const tc1Work = expanded[1];
    const tc1Idle = expanded[2];

    const onDutyHasTask = tc1OnDuty.rows.some(r => r.includes('Test Task 1'));
    const workHasTask = tc1Work.rows.some(r => r.includes('Test Task 1'));
    const idleIsEmpty = tc1Idle.isEmpty;

    console.log(`On-duty has task: ${onDutyHasTask} (expected: true)`);
    console.log(`Work Time has task: ${workHasTask} (expected: true)`);
    console.log(`Idle Time empty: ${idleIsEmpty} (expected: true)`);

    const tc1Pass = onDutyHasTask && workHasTask && idleIsEmpty;
    console.log(`\nTC1 ${tc1Pass ? 'PASSED' : 'FAILED'}`);

    if (!tc1Pass) {
      console.log('Details:');
      console.log(`  On-duty rows: ${JSON.stringify(tc1OnDuty.rows)}`);
      console.log(`  Work Time rows: ${JSON.stringify(tc1Work.rows)}`);
      console.log(`  Idle Time: ${JSON.stringify(tc1Idle)}`);
    }

    await shot(page, tc1Pass ? 'tc1-passed.png' : 'tc1-failed.png');

  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    await browser.close();
  }
}

run();
