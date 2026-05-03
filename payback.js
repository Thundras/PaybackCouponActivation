const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
    const isLoginMode = process.argv.includes('--login');
    const userDataDir = path.resolve('./user-data');
    const logDir = path.resolve('./logs');
    const logFile = path.join(logDir, `payback-${new Date().toISOString().slice(0, 10)}.log`);
    const screenshotDir = path.resolve('./screenshots');

    function ensureDirectoryExists(dirPath) {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
    }

    function cleanupOldLogs() {
        const oldFiles = fs.readdirSync(logDir)
            .filter(file => /^payback-\d{4}-\d{2}-\d{2}\.log$/.test(file))
            .sort()
            .reverse()
            .slice(5);
        for (const file of oldFiles) {
            try { fs.unlinkSync(path.join(logDir, file)); } catch {}
        }
    }

    ensureDirectoryExists(userDataDir);
    ensureDirectoryExists(screenshotDir);
    ensureDirectoryExists(logDir);
    cleanupOldLogs();

    function timestamp() {
        return new Date().toISOString();
    }

    function fileSafeTimestamp() {
        return new Date().toISOString().replace(/[:.]/g, '-');
    }

    function log(message) {
        const line = `[${timestamp()}] ${message}`;
        console.log(line);
        fs.appendFileSync(logFile, line + '\n', 'utf8');
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function takeScreenshot(page, prefix) {
        const file = path.join(screenshotDir, `${prefix}-${fileSafeTimestamp()}.png`);
        try {
            await page.screenshot({ path: file, fullPage: true });
            log(`Screenshot gespeichert: ${file}`);
        } catch (err) {
            log(`Screenshot fehlgeschlagen: ${err.message}`);
        }
    }

    async function minimizeWindow(page) {
        try {
            const cdp = await page.context().newCDPSession(page);
            const { windowId } = await cdp.send('Browser.getWindowForTarget');
            await cdp.send('Browser.setWindowBounds', {
                windowId,
                bounds: { windowState: 'minimized' }
            });
            log('Browser minimiert.');
        } catch (err) {
            log(`Fenster konnte nicht minimiert werden: ${err.message}`);
        }
    }

    async function isOnLoginPage(page) {
        const url = page.url().toLowerCase();
        if (url.includes('login')) {
            return true;
        }

        return await page
            .locator('input[type="password"]')
            .first()
            .isVisible()
            .catch(() => false);
    }

    async function isCouponPageLoaded(page) {
        const filterVisible = await page
            .locator('[data-testid="coupons-partner-filter-select"]')
            .first()
            .isVisible()
            .catch(() => false);

        const headlineVisible = await page
            .locator('[data-testid="not-activated-coupons-headline"]')
            .first()
            .isVisible()
            .catch(() => false);

        return filterVisible || headlineVisible;
    }

    async function getInactiveCouponCount(page) {
        const locator = page.locator('[data-testid="not-activated-coupons-headline"]').first();
        const visible = await locator.isVisible().catch(() => false);

        if (!visible) {
            return null;
        }

        const text = ((await locator.textContent()) || '').trim();
        const match = text.match(/\((\d+)\)/);

        return match ? parseInt(match[1], 10) : null;
    }

    async function getInactiveButtonCount(page) {
        return await page.locator('button[data-testid$="-not_activated"]').count();
    }

    async function scrollToLoadAllCoupons(page) {
        log('Scroll für Lazy Loading startet...');

        let lastHeight = -1;
        let stableRounds = 0;

        while (stableRounds < 3) {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await sleep(1500);

            const newHeight = await page.evaluate(() => document.body.scrollHeight);

            if (newHeight === lastHeight) {
                stableRounds++;
            } else {
                stableRounds = 0;
                lastHeight = newHeight;
            }
        }

        await page.evaluate(() => window.scrollTo(0, 0));
        await sleep(1000);

        log('Scroll für Lazy Loading abgeschlossen.');
    }

    async function isServiceUnavailableDialogOpen(page) {
        return await page
            .getByText('Dieser Service steht derzeit leider nicht zur Verfügung', { exact: false })
            .first()
            .isVisible()
            .catch(() => false);
    }

    async function closeServiceUnavailableDialog(page) {
        const closeButton = page.getByRole('button', { name: /schließen/i }).first();
        const visible = await closeButton.isVisible().catch(() => false);

        if (!visible) {
            return false;
        }

        try {
            await closeButton.click({ timeout: 3000 });
            await sleep(1000);
            return true;
        } catch {
            return false;
        }
    }

    async function recoverPage(page) {
        log('Recovery: Seite wird neu geladen...');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(3000);

        if (await isOnLoginPage(page)) {
            log('Nach Reload auf Login-Seite gelandet. Session vermutlich abgelaufen.');
            return false;
        }

        if (!(await isCouponPageLoaded(page))) {
            log('Coupon-Seite nach Reload nicht korrekt geladen.');
            return false;
        }

        await scrollToLoadAllCoupons(page);
        return true;
    }

    async function activateAllCoupons(page) {
        let activated = 0;
        let safetyCounter = 0;
        let noProgressStreak = 0;
        let reloadAttemptsForSameState = 0;
        let lastButtonCount = -1;

        while (safetyCounter < 500) {
            safetyCounter++;

            if (await isServiceUnavailableDialogOpen(page)) {
                log('PAYBACK meldet: Service derzeit nicht verfügbar. Abbruch.');
                const closed = await closeServiceUnavailableDialog(page);
                if (closed) {
                    log('Hinweis-Dialog wurde geschlossen.');
                }
                break;
            }

            const buttonsBefore = await getInactiveButtonCount(page);

            if (buttonsBefore === 0) {
                log('Keine aktivierbaren Buttons mehr im DOM.');
                break;
            }

            log(`Noch aktivierbare Buttons im DOM: ${buttonsBefore}`);

            if (buttonsBefore === lastButtonCount) {
                noProgressStreak++;
            } else {
                noProgressStreak = 0;
                reloadAttemptsForSameState = 0;
            }
            lastButtonCount = buttonsBefore;

            if (noProgressStreak >= 5) {
                log(`Kein Fortschritt mehr bei ${buttonsBefore} verbleibenden Buttons. Abbruch.`);
                break;
            }

            const button = page.locator('button[data-testid$="-not_activated"]').first();
            let progressed = false;

            try {
                await button.click({ timeout: 5000 });

                await sleep(2500);

                if (await isServiceUnavailableDialogOpen(page)) {
                    log('Nach Klick wurde ein Service-nicht-verfügbar-Dialog angezeigt. Abbruch.');
                    const closed = await closeServiceUnavailableDialog(page);
                    if (closed) {
                        log('Hinweis-Dialog wurde geschlossen.');
                    }
                    break;
                }

                let buttonsAfter = await getInactiveButtonCount(page);

                if (buttonsAfter < buttonsBefore) {
                    activated++;
                    progressed = true;
                    noProgressStreak = 0;
                    reloadAttemptsForSameState = 0;
                    log(`Coupon aktiviert: ${activated} (Buttons ${buttonsBefore} -> ${buttonsAfter})`);
                } else {
                    await sleep(4000);

                    if (await isServiceUnavailableDialogOpen(page)) {
                        log('Nach Wartezeit wurde ein Service-nicht-verfügbar-Dialog angezeigt. Abbruch.');
                        const closed = await closeServiceUnavailableDialog(page);
                        if (closed) {
                            log('Hinweis-Dialog wurde geschlossen.');
                        }
                        break;
                    }

                    buttonsAfter = await getInactiveButtonCount(page);

                    if (buttonsAfter < buttonsBefore) {
                        activated++;
                        progressed = true;
                        noProgressStreak = 0;
                        reloadAttemptsForSameState = 0;
                        log(`Coupon aktiviert: ${activated} (Buttons ${buttonsBefore} -> ${buttonsAfter})`);
                    }
                }
            } catch (err) {
                const msg = String(err.message || err);

                if (msg.includes('detached from the DOM')) {
                    await sleep(2000);

                    if (await isServiceUnavailableDialogOpen(page)) {
                        log('Nach DOM-Detach wurde ein Service-nicht-verfügbar-Dialog angezeigt. Abbruch.');
                        const closed = await closeServiceUnavailableDialog(page);
                        if (closed) {
                            log('Hinweis-Dialog wurde geschlossen.');
                        }
                        break;
                    }

                    const buttonsAfterDetach = await getInactiveButtonCount(page);

                    if (buttonsAfterDetach < buttonsBefore) {
                        activated++;
                        progressed = true;
                        noProgressStreak = 0;
                        reloadAttemptsForSameState = 0;
                        log(`Coupon vermutlich erfolgreich aktiviert trotz DOM-Detach: ${activated} (Buttons ${buttonsBefore} -> ${buttonsAfterDetach})`);
                    } else {
                        log('DOM-Detach erkannt, aber Button-Anzahl hat sich nicht reduziert.');
                    }
                } else {
                    log(`Fehler beim Klick: ${msg}`);

                    if (await isServiceUnavailableDialogOpen(page)) {
                        log('Nach Klick-Fehler wurde ein Service-nicht-verfügbar-Dialog angezeigt. Abbruch.');
                        const closed = await closeServiceUnavailableDialog(page);
                        if (closed) {
                            log('Hinweis-Dialog wurde geschlossen.');
                        }
                        break;
                    }
                }
            }

            if (progressed) {
                await sleep(1000);

                if (activated > 0 && activated % 20 === 0) {
                    log('Kurze Pause zur Entlastung...');
                    await sleep(8000);
                }

                continue;
            }

            reloadAttemptsForSameState++;

            if (reloadAttemptsForSameState > 2) {
                log(`Auch nach ${reloadAttemptsForSameState} Reload-Versuchen kein Fortschritt bei ${buttonsBefore} verbleibenden Buttons. Abbruch.`);
                break;
            }

            log(`Kein Fortschritt. Recovery-Reload ${reloadAttemptsForSameState}/2...`);

            const recovered = await recoverPage(page);
            if (!recovered) {
                log('Recovery fehlgeschlagen.');
                break;
            }

            await sleep(2000);
        }

        if (safetyCounter >= 500) {
            log('Safety-Limit erreicht. Abbruch, um Endlosschleife zu vermeiden.');
        }

        return activated;
    }

    let context;
    let page;

    try {
        log(`Start (${isLoginMode ? 'LOGIN' : 'AUTO'})`);

        context = await chromium.launchPersistentContext(userDataDir, {
            headless: false
        });

        page = context.pages()[0] || await context.newPage();

        page.on('framenavigated', frame => {
            if (frame === page.mainFrame()) {
                log(`Navigation erkannt: ${frame.url()}`);
            }
        });

        page.on('domcontentloaded', () => {
            log('DOMContentLoaded Event');
        });

        page.on('load', () => {
            log('Load Event');
        });

        if (!isLoginMode) {
            await minimizeWindow(page);
        }

        log('Navigation zur Coupon-Seite startet...');
        await page.goto('https://www.payback.de/coupons', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });
        log(`Navigation abgeschlossen. Aktuelle URL: ${page.url()}`);

        await sleep(3000);

        if (isLoginMode) {
            log('Login-Modus aktiv. Bitte jetzt manuell einloggen und danach Browser schließen.');

            page.once('close', async () => {
                log('Browser geschlossen. Session sollte gespeichert sein.');
                try {
                    await context.close();
                } catch {}
            });

            return;
        }

        if (await isOnLoginPage(page)) {
            log('Nicht eingeloggt. Bitte einmal mit --login anmelden.');
            await takeScreenshot(page, 'not-logged-in');
            await context.close();
            return;
        }

        if (!(await isCouponPageLoaded(page))) {
            log('Coupon-Seite wurde nicht wie erwartet geladen.');
            await takeScreenshot(page, 'coupon-page-not-ready');
            await context.close();
            return;
        }

        await scrollToLoadAllCoupons(page);

        const headlineStart = await getInactiveCouponCount(page);
        const buttonStart = await getInactiveButtonCount(page);

        log(`Headline Count zu Beginn: ${headlineStart ?? 'unbekannt'}`);
        log(`Aktivierbare Buttons zu Beginn: ${buttonStart}`);

        if (buttonStart === 0) {
            log('Keine nicht aktivierten Coupons vorhanden.');
            await context.close();
            log('Fertig');
            return;
        }

        const activated = await activateAllCoupons(page);
        log(`Aktiviert gesamt: ${activated}`);

        const headlineEnd = await getInactiveCouponCount(page);
        const buttonEnd = await getInactiveButtonCount(page);

        log(`Verbleibend laut Headline: ${headlineEnd ?? 'unbekannt'}`);
        log(`Verbleibende aktivierbare Buttons im DOM: ${buttonEnd}`);

        if (buttonEnd > 0) {
            log('WARNUNG: Es sind noch aktivierbare Buttons übrig.');
        }

        await sleep(1500);
        await context.close();
        log('Fertig');
    } catch (err) {
        log(`FATAL: ${err.message}`);

        if (page) {
            await takeScreenshot(page, 'fatal');
        }

        if (context) {
            try {
                await context.close();
            } catch {}
        }
    } finally {
        log('------------------------------------------------------');
    }
})();