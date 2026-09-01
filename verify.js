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
    
    // Test solo race flow
    await page.click('button:has-text("Solo Race")');
    await page.waitForTimeout(500);
    
    // Enter name
    await page.fill('input[id="nameInput"]', 'TestDriver');
    await page.click('button:has-text("Start Solo Race")');
    await page.waitForTimeout(1500);
    
    // Test race controls - tap to boost
    const tapButton = page.locator('button[id="trTapButton"]');
    if (await tapButton.isVisible()) {
        await tapButton.click();
        await page.waitForTimeout(500);
        await tapButton.click();
        await page.waitForTimeout(500);
    }
    
    // Test lane controls
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(200);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(200);
    
    // Check for errors during gameplay
    await page.waitForTimeout(1000);

    const bodyText = await page.locator('body').innerText();
    console.log('ERRORS=' + JSON.stringify(errors));
    console.log('BODY=' + bodyText.slice(0, 1500));
    
    if (errors.length > 0) {
        console.error('Found errors during test:', errors);
        process.exit(1);
    }
    
    await browser.close();
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
