import { expect, test } from '@playwright/test';
import { buildCase, submitCase } from '../test/helpers.js';

// Software WebGL so the 3D map renders in headless Chromium.
test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } });

function watchConsole(page, problems) {
  page.on('console', (msg) => msg.type() === 'error' && problems.push(msg.text()));
  page.on('pageerror', (err) => problems.push(String(err)));
}

test('lead doctor live view: rural block, homes coloured by case, details and search', async ({ page }) => {
  const problems = [];
  watchConsole(page, problems);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/live?seed=42&warmup=20&night=0&picker=0');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  await expect(page.locator('body')).toHaveAttribute('data-webgl', 'true');
  await expect(page.getByRole('note').filter({ hasText: 'Not for clinical use' })).toBeVisible();
  await expect(page.locator('#legend')).toContainText('Urgent: refer now');
  await expect(page.locator('#legend')).toContainText('Doctor review today');
  await expect(page.locator('#kpi-cases [data-value]')).toHaveText(/^\d+$/);
  await expect(page.locator('#kpi-cases [data-delta]')).toContainText('review today');

  // The first open case opens its home: case details plus the doctor-decides note.
  await page.locator('md-primary-tab[data-tab="cases"]').click();
  const firstCase = page.locator('#table-wrap tbody tr').first();
  await expect(firstCase).toContainText(/Urgent|Review today/);
  await firstCase.locator('md-text-button').click();
  await expect(page.locator('#detail')).toContainText('Young infant');
  await expect(page.locator('#detail')).toContainText('The doctor makes the clinical decision');

  // Search goes straight to a village.
  await page.locator('#search').click();
  await page.keyboard.type('Nammiyampattu');
  await page.keyboard.press('Enter');
  await expect(page.locator('#detail h2')).toHaveText('Nammiyampattu');
  await expect(page.locator('#detail')).toContainText('Open home-visit cases');

  await page.locator('#night-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(problems).toEqual([]);
});

test('ASHA case pins its place on the dashboard; the doctor opens it and escalates, all on one screen', async ({ page, baseURL }) => {
  const problems = [];
  watchConsole(page, problems);
  await page.setViewportSize({ width: 1440, height: 900 });

  // /doctor is the 3D dashboard now; the doctor signs in there.
  await page.goto('/doctor');
  await expect(page).toHaveURL(/\/live\?app=doctor$/);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  await page.locator('#queue-chip').click();
  await page.locator('#signin-code input').fill('doctor-demo');
  await page.locator('#signin-submit').click();
  await expect(page.locator('#queue-chip')).toHaveClass(/live/, { timeout: 20_000 });
  await expect(page.locator('#user-headline')).toHaveText('Dr. R. Senthil');

  // Parvati's phone shows a doctor online; she sends a photo and a voice note (API stand-in).
  const login = await fetch(`${baseURL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'asha-demo' }) });
  const { token } = await login.json();
  const profile = await (await fetch(`${baseURL}/api/profile`, { headers: { Authorization: `Bearer ${token}` } })).json();
  expect(profile.doctorsOnline).toBeGreaterThan(0);
  const record = buildCase({ patient: { name: 'Live Map Test', ageValue: 8, ageUnit: 'days', sex: 'female' } });
  const sent = await submitCase(baseURL, token, record);
  expect(sent.status, await sent.clone().text()).toBe(201);

  // A red pin and the Needs attention list mark her village, without a refresh.
  await expect(page.locator('#new-case-toast')).toBeVisible({ timeout: 20_000 });
  // First start: every panel is folded except Active cases, the doctor's main view.
  await expect(page.locator('body')).toHaveClass(/collapsed-attention/);
  await expect(page.locator('#detail .detail__head h2')).toHaveText('Active cases');
  await expect(page.locator('#detail .issue', { hasText: 'Live Map Test' })).toBeVisible();
  await page.locator('[data-collapse="attention"]').click();
  const place = page.locator('#attention-list .attn', { hasText: 'Nammiyampattu' });
  await expect(place).toContainText('Live Map Test');
  await expect(place).toContainText('new');
  await expect(page.locator('.map-label--attention', { hasText: 'Nammiyampattu' })).toBeAttached();

  // Place, then case: the side panel shows the AI-organised view.
  await place.click();
  const detail = page.locator('#detail');
  await expect(detail.locator('h2')).toHaveText('Nammiyampattu');
  await detail.locator('.issue', { hasText: 'Live Map Test' }).click();
  await expect(detail.locator('.detail__head h2')).toHaveText('Live Map Test');
  await expect(page.locator('body')).toHaveAttribute('data-panel', 'case');
  for (const text of ['Symptoms and danger signs', 'Voice note, in English', 'Patient and medical details', 'Sent by', 'Your decision']) await expect(detail).toContainText(text);
  await expect(detail.locator('.rc-photo img')).toBeVisible();
  await expect(detail.locator('.rc-play')).toBeVisible();

  // Urgent by the rules, so escalation is offered first; the doctor picks the district hospital.
  await detail.locator('md-radio[value="Government Medical College Hospital, Tiruvannamalai"]').click();
  await detail.locator('.rc-assess textarea').fill('Provisional: possible serious infection; needs examination.');
  await detail.locator('.rc-primary').click();
  await expect(detail.locator('.rc-banner.done')).toContainText('Sent to Parvati');
  const mine = (await (await fetch(`${baseURL}/api/worker/cases/${record.id}`, { headers: { Authorization: `Bearer ${token}` } })).json()).case;
  expect(mine.decision.outcome).toBe('refer_now');
  expect(mine.decision.referTo).toBe('Government Medical College Hospital, Tiruvannamalai');
  expect(mine.decision.instructions).toContain('Take the patient to Government Medical College Hospital, Tiruvannamalai now.');
  await expect(page.locator('#attention-list .attn', { hasText: 'Live Map Test' })).toHaveCount(0);

  // "Switch app" returns to the picker; the rural worker app then opens as a phone on the same screen.
  await page.locator('#switch-app').click();
  await expect(page.locator('#picker')).toBeVisible();
  await page.locator('#pick-worker').click();
  await expect(page.locator('#picker')).toBeHidden();
  await expect(page.frameLocator('#phone-frame').locator('#access-code')).toBeVisible();
  await page.locator('#switch-app').click();
  await page.locator('#pick-doctor').click();
  await expect(page.locator('#phone')).toBeHidden();
  await page.locator('[data-collapse="attention"]').click();
  await expect(page.locator('body')).toHaveClass(/collapsed-attention/);
  await page.locator('[data-collapse="attention"]').click();
  // Cases full screen, and back to the map.
  await page.locator('#cases-full').click();
  await expect(page.locator('body')).toHaveClass(/cases-full/);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).not.toHaveClass(/cases-full/);
  expect(problems).toEqual([]);
});
test('after prescribing, the doctor scans the block for the medicines and sends a bike to the patient', async ({ page, baseURL }) => {
  const problems = [];
  watchConsole(page, problems);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/live?seed=11&warmup=5&night=0&picker=0');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  await page.locator('#queue-chip').click();
  await page.locator('#signin-code input').fill('doctor-demo');
  await page.locator('#signin-submit').click();
  await expect(page.locator('#queue-chip')).toHaveClass(/live/, { timeout: 20_000 });

  const { token } = await (await fetch(`${baseURL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'asha-demo' }) })).json();
  const record = buildCase({ patient: { name: 'Medicine Run Test', ageValue: 7, ageUnit: 'years', sex: 'male' } });
  expect((await submitCase(baseURL, token, record)).status).toBe(201);
  // Straight from Active cases (the right panel) to the case.
  const detail = page.locator('#detail');
  await detail.locator('.issue', { hasText: 'Medicine Run Test' }).click({ timeout: 20_000 });
  await expect(detail).toContainText('Your decision');

  // Prescribe two medicines with doses.
  await detail.locator('md-primary-tab[data-mode="treat"]').click();
  for (const [name, dose] of [['Cetirizine', '5 mg'], ['Calamine lotion', 'thin layer']]) {
    await detail.locator('md-assist-chip', { hasText: name }).click();
    await detail.locator('.rc-med__dose input').last().fill(dose);
  }
  await detail.locator('.rc-primary').click();
  await expect(detail.locator('.rc-banner.done')).toContainText('Sent to Parvati');

  // Look for medicines: the scan finds places with stock, on the map and in the panel.
  await detail.locator('.rc-find').click();
  await expect(detail.locator('.detail__head h2')).toHaveText('Look for medicines');
  await expect(detail.locator('.rx-scan')).toContainText('places in the block have at least one', { timeout: 10_000 });
  await expect(page.locator('.map-label--med').first()).toBeAttached();
  await expect(detail.locator('.rx-source').first()).toContainText('from the patient');
  await expect(detail.locator('.rx-suggest')).toContainText('collects from');
  await expect(detail.locator('.rx-stops li').first()).toBeVisible();
  await expect(page.locator('.map-label--med.map-label--chosen').first()).toBeAttached();

  // Send the bike: the run is tracked and the ASHA's phone shows it on the way.
  await detail.locator('.rx-send').click();
  await expect(detail.locator('.detail__head h2')).toHaveText(/^RX-5\d\d$/, { timeout: 10_000 });
  await expect(detail).toContainText('Pickup round');
  await expect(page.locator('#tracker')).toContainText('Prescription delivery');
  const mine = (await (await fetch(`${baseURL}/api/worker/cases/${record.id}`, { headers: { Authorization: `Bearer ${token}` } })).json()).case;
  expect(mine.dispatch.status).toBe('on_the_way');
  expect(mine.dispatch.stops.length).toBeGreaterThan(0);
  expect(problems).toEqual([]);
});

test('a doctor can sign in from the live view itself', async ({ page }) => {
  await page.goto('/live?seed=7&warmup=5&night=0&picker=0');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  await expect(page.locator('#queue-text')).toHaveText('Doctor sign in');
  await page.locator('#queue-chip').click();
  await page.locator('#signin-code input').fill('asha-demo');
  await page.locator('#signin-submit').click();
  await expect(page.locator('#signin-error')).toBeVisible();
  await page.locator('#signin-code input').fill('doctor-demo');
  await page.locator('#signin-submit').click();
  await expect(page.locator('#queue-chip')).toHaveClass(/live/, { timeout: 20_000 });
});

test('first load shows the entry picker over the live map; either app can be chosen and Switch returns to it', async ({ page }) => {
  const problems = [];
  watchConsole(page, problems);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/live?seed=5&warmup=3&night=0');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });

  // The live map keeps running behind a modal overlay with two large cards: doctor left, worker right.
  const picker = page.locator('#picker');
  await expect(picker).toBeVisible();
  await expect(picker).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('#scene')).toBeVisible();
  const [doctor, worker] = await Promise.all([page.locator('#pick-doctor').boundingBox(), page.locator('#pick-worker').boundingBox()]);
  expect(doctor.x).toBeLessThan(worker.x);
  expect(doctor.width).toBeGreaterThan(400);
  expect(worker.width).toBeGreaterThan(400);
  await expect(page.locator('#pick-doctor')).toContainText('Doctor Dashboard');
  await expect(page.locator('#pick-worker')).toContainText('Rural Worker App');
  // What is behind the overlay cannot be used while it is open.
  await expect(page.locator('.topbar')).toHaveAttribute('inert', '');
  await page.screenshot({ path: 'test-results/entry-picker.png' });

  // Doctor Dashboard: overlay gone, dashboard usable.
  await page.locator('#pick-doctor').click();
  await expect(picker).toBeHidden();
  await expect(page.locator('.topbar')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#detail .detail__head h2')).toHaveText('Active cases');
  await expect(page.locator('#phone')).toBeHidden();
  await expect(page.locator('#phone-toggle')).toHaveCount(0);

  // Switch app: back to the same picker (Esc enters the dashboard); Rural Worker opens the phone app.
  await page.locator('#switch-app').click();
  await expect(picker).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await page.locator('#switch-app').click();
  await page.locator('#pick-worker').click();
  await expect(picker).toBeHidden();
  await expect(page.locator('#phone')).toBeVisible();
  await expect(page.frameLocator('#phone-frame').locator('#access-code')).toBeVisible();

  // Links can skip the picker.
  await page.goto('/live?app=doctor&seed=5&warmup=3');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  await expect(page.locator('#picker')).toBeHidden();
  expect(problems).toEqual([]);
});
test('live view on a phone in the dark scheme', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  const problems = [];
  watchConsole(page, problems);
  await page.goto('/live?seed=7&warmup=10&picker=0');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  // Light on first open, even when the phone is in dark mode.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('#attention')).toBeVisible();
  await expect(page.locator('#attention')).toContainText('Sign in as a doctor');
  await page.locator('md-primary-tab[data-sheet="tables"]').click();
  await expect(page.locator('#tables')).toBeVisible();
  await expect(page.locator('#attention')).toBeHidden();
  await page.locator('md-primary-tab[data-sheet="detail"]').click();
  await expect(page.locator('#detail')).toContainText('Jawadhu Hills block, live');
  // The top bar scrolls sideways, every icon is reachable, and the phone icon opens the ASHA app full page.
  const bar = await page.locator('.topbar').evaluate((b) => ({ scrolls: b.scrollWidth > b.clientWidth, overflowX: getComputedStyle(b).overflowX }));
  expect(bar).toEqual({ scrolls: true, overflowX: 'auto' });
  await expect(page.locator('#switch-app')).toBeVisible();
  await expect(page.locator('#switch-app')).toBeInViewport();
  await page.locator('#user-button').scrollIntoViewIfNeeded();
  await expect(page.locator('#user-button')).toBeInViewport();
  await page.locator('#switch-app').scrollIntoViewIfNeeded();
  await page.locator('#switch-app').click();
  await expect(page.locator('#picker')).toBeVisible();
  await page.locator('#pick-worker').click();
  await expect(page).toHaveURL(/\/asha\?from=live$/);
  await expect(page.locator('#back-to-dashboard')).toBeVisible();
  expect(problems).toEqual([]);
  await ctx.close();
});
