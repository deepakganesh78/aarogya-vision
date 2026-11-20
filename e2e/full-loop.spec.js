import { expect, test } from '@playwright/test';

// Fail the test on Content-Security-Policy violations or uncaught errors.
function watchConsole(page, problems) {
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource|net::ERR_INTERNET_DISCONNECTED/.test(msg.text())) problems.push(msg.text());
  });
  page.on('pageerror', (err) => problems.push(String(err)));
}

async function readOutbox(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('aarogya-vision');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const req = open.result.transaction('outbox').objectStore('outbox').getAll();
          req.onsuccess = () =>
            resolve(
              req.result.map((r) => ({
                metaIsCiphertext: r.meta.data instanceof ArrayBuffer,
                plaintextVisible: new TextDecoder().decode(r.meta.data).includes('workerFlag'),
                photoType: r.photo?.type ?? null,
                audioType: r.audio?.type ?? null
              }))
            );
        };
      })
  );
}

// Optional patient details on the visit screen (name, age, sex; pregnancy for women), folded by default.
async function fillPatient(page, { name, age, unit, sex }) {
  await expect(page.locator('#patient-card')).toBeVisible();
  if (await page.locator('#patient-card.collapsed').count()) await page.locator('#patient-toggle').click();
  await page.locator('#p-name input').fill(name);
  await page.locator('#p-age input').fill(String(age));
  await page.locator('#p-unit').evaluate((select, value) => {
    select.value = value;
  }, unit);
  await page.locator(`#p-sex md-filter-chip[data-sex="${sex}"]`).click();
}

test('ASHA enters the patient, sends a photo or voice note; AI fills the rest; doctor replies', async ({ browser }) => {
  const problems = [];

  // ---- ASHA worker, phone-sized ----
  const workerCtx = await browser.newContext({ viewport: { width: 412, height: 915 }, permissions: ['microphone'] });
  const worker = await workerCtx.newPage();
  watchConsole(worker, problems);
  await worker.goto('/asha');
  await expect(worker.getByRole('note')).toContainText('Not for clinical use');
  await worker.locator('#access-code input').fill('asha-demo');
  await worker.locator('#login-submit').click();
  await expect(worker.locator('#new-visit')).toBeVisible();
  await expect(worker.locator('#empty-state')).toBeVisible();
  await worker.waitForFunction(() => Boolean(navigator.serviceWorker?.controller));

  // ---- Visit 1: offline, photo only, danger switch on ----
  await workerCtx.setOffline(true);
  await worker.reload();
  await expect(worker.locator('#new-visit')).toBeVisible();
  await expect(worker.locator('#offline-banner')).toBeVisible();

  await worker.locator('#lang-button').click();
  await worker.locator('md-menu-item[data-lang="ta"]').click();
  await expect.poll(() => worker.locator('#new-visit').evaluate((fab) => fab.label)).toBe('புதிய வருகை');
  await worker.locator('#new-visit').click();
  // The patient card is required: always open, and Send stops until name, age and sex are in.
  await expect(worker.locator('#patient-card')).not.toHaveClass(/collapsed/);
  await worker.locator('#send-case').click();
  await expect(worker.locator('#patient-error')).toHaveText('நோயாளியின் பெயரை எழுதுங்கள்.');
  await fillPatient(worker, { name: 'Baby of Kaveri', age: 8, unit: 'days', sex: 'female' });
  await expect(worker.locator('#take-photo')).toBeVisible();
  await expect(worker.locator('#record')).toBeVisible();

  await worker.locator('#send-case').click();
  await expect(worker.locator('#capture-error')).toHaveText('முதலில் படம் எடுக்கவும் அல்லது உங்கள் குரலைப் பதிவு செய்யவும்.');

  await worker.locator('#photo-input').setInputFiles('e2e/fixtures/synthetic-photo.jpg');
  await expect(worker.locator('#photo-item')).toBeVisible();
  // Offline, the rash photo check says it needs the internet; the doctor still gets the photo.
  await expect(worker.locator('#photo-check')).toContainText('இணையம் தேவை');
  await worker.locator('#send-case').click();
  await expect(worker.locator('#capture-error')).toContainText('ஒப்புதலை');

  await worker.locator('#consent').click();
  await worker.locator('#danger-flag').click();
  await worker.screenshot({ path: 'test-results/worker-capture.png', fullPage: true });
  await worker.locator('#send-case').click();

  // Offline: the danger switch gives the urgent advice instantly, plus the danger-sign reminder.
  await expect(worker.locator('#result-card h1')).toHaveText('அவசரம்: உடனே பரிந்துரை செய்யவும்');
  await expect(worker.locator('#result-card .reminder')).toContainText('இவற்றில் ஏதேனும் இருந்தால் உடனே பரிந்துரை செய்யவும்');
  await expect(worker.locator('#delivery-status')).toHaveText(/இணைப்பு கிடைத்ததும்/);
  await worker.screenshot({ path: 'test-results/worker-offline-result.png', fullPage: true });

  const outbox = await readOutbox(worker);
  expect(outbox).toEqual([{ metaIsCiphertext: true, plaintextVisible: false, photoType: 'image/jpeg', audioType: null }]);

  await worker.locator('#result-done').click();
  await expect(worker.locator('.case-item[data-pending="true"]')).toHaveCount(1);

  // Network returns: the saved visit sends itself.
  await workerCtx.setOffline(false);
  await expect(worker.locator('.case-item[data-pending="true"]')).toHaveCount(0, { timeout: 30_000 });
  expect(await readOutbox(worker)).toHaveLength(0);

  // ---- Visit 2: online, voice only. AI fills age, temperature and danger signs. ----
  await worker.locator('#new-visit').click();
  await fillPatient(worker, { name: 'Baby of Lakshmi', age: 8, unit: 'days', sex: 'female' });
  // Consent and the danger switch must never carry over from the previous family's visit.
  expect(await worker.locator('#consent').evaluate((s) => s.selected)).toBe(false);
  expect(await worker.locator('#danger-flag').evaluate((s) => s.selected)).toBe(false);
  await expect(worker.locator('#consent')).not.toHaveAttribute('aria-checked', 'true');
  await worker.locator('#record').click();
  await expect(worker.locator('#record-progress')).toBeVisible();
  await worker.waitForTimeout(2200);
  await worker.locator('#record').click();
  await expect(worker.locator('#audio-item')).toBeVisible();
  await worker.locator('#consent').click();
  expect(await worker.locator('#consent').evaluate((s) => s.selected)).toBe(true);
  await worker.locator('#send-case').click();

  await expect(worker.locator('#view-result')).toBeVisible();
  const result = worker.locator('#result-card');
  await expect(result.locator('h1')).toHaveText('அவசரம்: உடனே பரிந்துரை செய்யவும்', { timeout: 20_000 });
  await expect(result).toContainText('நாங்கள் புரிந்துகொண்டது');
  await expect(result.locator('.patient-chip')).toContainText('Baby of Lakshmi');
  await expect(result.locator('.fact').filter({ hasText: '8 நாட்கள்' })).toBeVisible();
  await expect(result.locator('.fact').filter({ hasText: '38.3 °C' })).toContainText('குரலிலிருந்து');
  await expect(result.locator('.found-list').first()).toContainText('பால் குடிக்க முடியவில்லை');
  await expect(worker.locator('#delivery-status')).toHaveText('மருத்துவருக்கு அனுப்பப்பட்டது.');
  await worker.screenshot({ path: 'test-results/worker-understood.png', fullPage: true });
  await worker.locator('#result-done').click();
  await expect(worker.locator('.case-item')).toHaveCount(2);

  // ---- Doctor ----
  const doctorCtx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const doctor = await doctorCtx.newPage();
  watchConsole(doctor, problems);
  // The classic list console (the 3D dashboard flow is covered in live-view.spec.js).
  await doctor.goto('/doctor/classic');
  await expect(doctor.locator('#ai-badge-text')).toHaveText('AI: MOCK stub (no model)');
  await doctor.locator('#access-code input').fill('doctor-demo');
  await doctor.locator('#login-submit').click();

  await expect(doctor.locator('.queue-item')).toHaveCount(2);
  await expect(doctor.locator('.queue-item').filter({ hasText: 'Baby of Kaveri' })).toContainText('Urgent');
  const voiceCase = doctor.locator('.queue-item').filter({ hasText: 'Baby of Lakshmi' });
  await expect(voiceCase).toContainText('Urgent');
  await voiceCase.click();

  const detail = doctor.locator('#detail');
  await expect(detail).toContainText('[MOCK AI - no model was called]');
  await expect(detail).toContainText('Baby of Lakshmi, 8 days, female');
  await expect(detail).toContainText('First visit: no earlier cases for this patient.');
  await expect(detail).toContainText('38.3 °C (voice note, AI)');
  await expect(detail).toContainText('Very severe disease in young infants');
  await expect(detail.locator('.safety-note')).toContainText('You make the clinical decision');
  await expect(detail.locator('audio')).toBeVisible();
  await doctor.screenshot({ path: 'test-results/doctor-review.png', fullPage: true });

  await detail.locator('#outcome-refer_now').click();
  await detail.locator('#instructions textarea').fill('Refer to the PHC now. Keep the baby warm and breastfeed on the way.');
  await detail.locator('#send-decision').click();
  await expect(detail).toContainText('What the ASHA sees (Tamil, machine-translated by MOCK)');
  await expect(doctor.locator('.queue-item')).toHaveCount(1);

  // ---- Worker sees the reply: an alert, and the visit highlighted in the decision's colour ----
  await worker.locator('#sync-now').click();
  const alert = worker.locator('#reply-alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('மருத்துவர் பதில் அனுப்பினார்');
  await expect(alert).toHaveClass(/reply-alert--urgent/);
  const replied = worker.locator('.case-item').filter({ hasText: 'மருத்துவர் பதிலளித்தார்' });
  await expect(replied).toHaveCount(1);
  await expect(replied).toHaveClass(/case-item--unread/);
  await expect(replied).toHaveClass(/case-item--urgent/);
  await expect(replied).toContainText('புதிய பதில்');
  await alert.locator('md-filled-button').click();
  await expect(alert).toBeHidden();
  const reply = worker.locator('.doctor-reply');
  await expect(reply).toHaveClass(/doctor-reply--urgent/);
  await expect(reply.locator('h2')).toHaveText('மருத்துவரின் பதில்');
  await expect(reply.locator('.instructions')).toHaveText('[MOCK ta translation] Refer to the PHC now. Keep the baby warm and breastfeed on the way.');
  await expect(reply.locator('.original')).toHaveText('Refer to the PHC now. Keep the baby warm and breastfeed on the way.');
  await worker.screenshot({ path: 'test-results/worker-reply.png', fullPage: true });

  await worker.emulateMedia({ colorScheme: 'dark' });
  expect(await worker.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe('rgb(250, 248, 255)');
  await worker.screenshot({ path: 'test-results/worker-reply-dark.png', fullPage: true });

  expect(problems, problems.join('\n')).toEqual([]);
  await workerCtx.close();
  await doctorCtx.close();
});

test('doctor dashboard rejects worker credentials and worker app rejects doctor credentials', async ({ page }) => {
  await page.goto('/doctor/classic');
  await page.locator('#access-code input').fill('asha-demo');
  await page.locator('#login-submit').click();
  await expect(page.locator('#login-error')).toBeVisible();

  await page.goto('/asha');
  await page.locator('#access-code input').fill('doctor-demo');
  await page.locator('#login-submit').click();
  await expect(page.locator('#login-error')).toBeVisible();
});

test('rash photo check on the ASHA phone: how it looks and which danger signs to check, never a disease', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
  const page = await ctx.newPage();
  const problems = [];
  watchConsole(page, problems);
  await page.goto('/asha');
  await page.locator('#access-code input').fill('asha-demo');
  await page.locator('#login-submit').click();
  await page.locator('#new-visit').click();
  await page.locator('#photo-input').setInputFiles('e2e/fixtures/synthetic-photo.jpg');
  const check = page.locator('#photo-check');
  await expect(check).toContainText('Blisters, pus spots or crusts');
  await expect(check).toContainText('Also check for these danger signs');
  await expect(check).toContainText('not a diagnosis');
  await page.locator('#remove-photo').click();
  await expect(check).toBeHidden();
  expect(problems).toEqual([]);
  await ctx.close();
});