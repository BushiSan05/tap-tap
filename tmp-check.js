const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];

    page.on('pageerror', (err) => errors.push('PAGEERROR: ' + err.message));
    page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push('CONSOLE: ' + msg.text());
    });

    await page.goto('http://localhost:8000', { waitUntil: 'load' });
    await page.waitForTimeout(1000);

    console.log('INITIAL_TEXT=' + await page.locator('body').innerText());

    await page.click('button:has-text("Solo Race")');
    await page.waitForTimeout(500);
    console.log('AFTER_SOLO_MODE=' + await page.locator('body').innerText());

    const nameInput = page.locator('input[id="nameInput"]');
    if (await nameInput.count()) {
        await nameInput.fill('TestDriver');
    }
    await page.click('button:has-text("Start Solo Race")');
    await page.waitForTimeout(1500);
    console.log('AFTER_START=' + await page.locator('body').innerText());

    const tapButton = page.locator('button[id="trTapButton"]');
    if (await tapButton.isVisible()) {
        await tapButton.click();
        await page.waitForTimeout(500);
        console.log('AFTER_TAP=' + await page.locator('body').innerText());
    }

    await page.waitForTimeout(5000);
    console.log('FINAL_TEXT=' + await page.locator('body').innerText());
    console.log('ERRORS=' + JSON.stringify(errors));

    await browser.close();
})();
