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
    await page.click('button:has-text("Solo Race")');
    await page.waitForTimeout(1200);

    const bodyText = await page.locator('body').innerText();
    console.log('ERRORS=' + JSON.stringify(errors));
    console.log('BODY=' + bodyText.slice(0, 1200));
    await browser.close();
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
