const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

(async () => {
    const isLoginMode = process.argv.includes('--login');
    const userDataDir = path.resolve('./user-data');
    const logDir = path.resolve('./logs');
    const logFile = path.join(logDir, `payback-${new Date().toISOString().slice(0, 10)}.log`);
    const screenshotDir = path.resolve('./screenshots');
    const lockFile = path.resolve('./payback.lock');

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

    /**
     * Acquires a process lock to prevent concurrent AUTO instances.
     * Exits the process immediately if the lock file already exists.
     */
    function acquireLock() {
        if (fs.existsSync(lockFile)) {
            const pid = fs.readFileSync(lockFile, 'utf8').trim();
            console.log(`[${new Date().toISOString()}] Another instance is already running (PID ${pid}). Exiting.`);
            process.exit(0);
        }
        fs.writeFileSync(lockFile, String(process.pid), 'utf8');
    }

    /** Releases the process lock file. */
    function releaseLock() {
        try { fs.unlinkSync(lockFile); } catch {}
    }

    ensureDirectoryExists(userDataDir);
    ensureDirectoryExists(screenshotDir);
    ensureDirectoryExists(logDir);
    cleanupOldLogs();

    if (!isLoginMode) {
        acquireLock();
    }

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

    /**
     * Shows a Windows notification.
     * - persistent=false: toast via PowerShell WinRT (auto-dismiss, stays in Action Center).
     * - persistent=true: mshta msgbox dialog (stays on screen until the user clicks OK).
     * @param {string} title - Notification title.
     * @param {string} message - Notification body.
     * @param {boolean} persistent - true = modal dialog (stays until dismissed).
     */
    function showWindowsToast(title, message, persistent = false) {
        const xmlEscape = str => str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');

        // persistent=true: scenario="alarm" with dismiss button — stays on screen until the user clicks OK.
        // persistent=false: default toast (~7s auto-dismiss, stays in Action Center).
        const toastXml = persistent
            ? `<toast scenario="alarm"><visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text><text>${xmlEscape(message)}</text></binding></visual><audio silent="true"/><actions><action content="OK" arguments="dismiss" activationType="system"/></actions></toast>`
            : `<toast><visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text><text>${xmlEscape(message)}</text></binding></visual></toast>`;
        const script = `
$r = "HKCU:\\SOFTWARE\\Classes\\AppUserModelId\\PaybackCouponActivation"
if (-not (Test-Path $r)) { New-Item $r -Force | Out-Null; Set-ItemProperty $r DisplayName "Payback Coupon Activation"; Set-ItemProperty $r ShowInSettings 1 -Type DWord }
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('${toastXml}')
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("PaybackCouponActivation").Show((New-Object Windows.UI.Notifications.ToastNotification($xml)))
`;
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        const proc = spawn(
            'powershell',
            ['-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
            { detached: true, stdio: 'ignore', windowsHide: true }
        );
        proc.unref();
    }

    async function setWindowState(page, state) {
        try {
            const cdp = await page.context().newCDPSession(page);
            const { windowId } = await cdp.send('Browser.getWindowForTarget');
            await cdp.send('Browser.setWindowBounds', {
                windowId,
                bounds: { windowState: state }
            });
        } catch (err) {
            log(`Window state '${state}' could not be set: ${err.message}`);
        }
    }

    async function minimizeWindow(page) {
        await setWindowState(page, 'minimized');
        log('Browser minimized.');
    }

    async function takeScreenshot(page, prefix) {
        const file = path.join(screenshotDir, `${prefix}-${fileSafeTimestamp()}.png`);
        try {
            await setWindowState(page, 'normal');
            await sleep(300);
            await page.screenshot({ path: file, fullPage: true });
            log(`Screenshot saved: ${file}`);
        } catch (err) {
            log(`Screenshot failed: ${err.message}`);
        } finally {
            await setWindowState(page, 'minimized');
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
        log('Scroll for lazy loading started...');

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

        log('Scroll for lazy loading completed.');
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
        log('Recovery: reloading page...');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(3000);

        if (await isOnLoginPage(page)) {
            log('Redirected to login page after reload. Session likely expired.');
            return false;
        }

        if (!(await isCouponPageLoaded(page))) {
            log('Coupon page did not load correctly after reload.');
            return false;
        }

        await scrollToLoadAllCoupons(page);
        return true;
    }

    async function activateAllCoupons(page) {
        let activated = 0;
        let safetyCounter = 0;
        let noProgressStreak = 0;
        let rateLimitStreak = 0;
        let reloadAttemptsForSameState = 0;
        let lastButtonCount = -1;

        while (safetyCounter < 500) {
            safetyCounter++;

            if (await isServiceUnavailableDialogOpen(page)) {
                log('PAYBACK reports service currently unavailable. Aborting.');
                const closed = await closeServiceUnavailableDialog(page);
                if (closed) {
                    log('Info dialog closed.');
                }
                break;
            }

            const buttonsBefore = await getInactiveButtonCount(page);

            if (buttonsBefore === 0) {
                log('No more activatable buttons in DOM.');
                break;
            }

            log(`Activatable buttons remaining in DOM: ${buttonsBefore}`);

            if (buttonsBefore === lastButtonCount) {
                noProgressStreak++;
            } else {
                noProgressStreak = 0;
                reloadAttemptsForSameState = 0;
            }
            lastButtonCount = buttonsBefore;

            if (noProgressStreak >= 5) {
                log(`No progress for ${buttonsBefore} remaining buttons. Aborting.`);
                break;
            }

            const button = page.locator('button[data-testid$="-not_activated"]').first();
            let progressed = false;
            // Tracks a clean failure: click executed without error or service dialog, but coupon did not activate.
            // Used to detect PAYBACK-side rate limiting distinct from DOM/network errors.
            let cleanFailure = false;

            try {
                await button.click({ timeout: 5000 });

                await sleep(2500);

                if (await isServiceUnavailableDialogOpen(page)) {
                    log('Service unavailable dialog appeared after click. Aborting.');
                    const closed = await closeServiceUnavailableDialog(page);
                    if (closed) {
                        log('Info dialog closed.');
                    }
                    break;
                }

                let buttonsAfter = await getInactiveButtonCount(page);

                if (buttonsAfter < buttonsBefore) {
                    activated++;
                    progressed = true;
                    noProgressStreak = 0;
                    rateLimitStreak = 0;
                    reloadAttemptsForSameState = 0;
                    log(`Coupon activated: ${activated} (buttons ${buttonsBefore} -> ${buttonsAfter})`);
                } else {
                    await sleep(4000);

                    if (await isServiceUnavailableDialogOpen(page)) {
                        log('Service unavailable dialog appeared after wait. Aborting.');
                        const closed = await closeServiceUnavailableDialog(page);
                        if (closed) {
                            log('Info dialog closed.');
                        }
                        break;
                    }

                    buttonsAfter = await getInactiveButtonCount(page);

                    if (buttonsAfter < buttonsBefore) {
                        activated++;
                        progressed = true;
                        noProgressStreak = 0;
                        rateLimitStreak = 0;
                        reloadAttemptsForSameState = 0;
                        log(`Coupon activated: ${activated} (buttons ${buttonsBefore} -> ${buttonsAfter})`);
                    } else {
                        cleanFailure = true;
                    }
                }
            } catch (err) {
                const msg = String(err.message || err);

                if (msg.includes('detached from the DOM')) {
                    await sleep(2000);

                    if (await isServiceUnavailableDialogOpen(page)) {
                        log('Service unavailable dialog appeared after DOM detach. Aborting.');
                        const closed = await closeServiceUnavailableDialog(page);
                        if (closed) {
                            log('Info dialog closed.');
                        }
                        break;
                    }

                    const buttonsAfterDetach = await getInactiveButtonCount(page);

                    if (buttonsAfterDetach < buttonsBefore) {
                        activated++;
                        progressed = true;
                        noProgressStreak = 0;
                        rateLimitStreak = 0;
                        reloadAttemptsForSameState = 0;
                        log(`Coupon likely activated despite DOM detach: ${activated} (buttons ${buttonsBefore} -> ${buttonsAfterDetach})`);
                    } else {
                        log('DOM detach detected, but button count did not decrease.');
                    }
                } else {
                    log(`Click error: ${msg}`);

                    if (await isServiceUnavailableDialogOpen(page)) {
                        log('Service unavailable dialog appeared after click error. Aborting.');
                        const closed = await closeServiceUnavailableDialog(page);
                        if (closed) {
                            log('Info dialog closed.');
                        }
                        break;
                    }
                }
            }

            if (progressed) {
                await sleep(1000);

                if (activated > 0 && activated % 20 === 0) {
                    log('Short pause to reduce load...');
                    await sleep(8000);
                }

                continue;
            }

            if (cleanFailure) {
                rateLimitStreak++;
                if (rateLimitStreak >= 3) {
                    log('Rate limit suspected. Backing off for 90 seconds...');
                    await sleep(90000);
                    rateLimitStreak = 0;
                    noProgressStreak = 0;
                    continue;
                }
            }

            reloadAttemptsForSameState++;

            if (reloadAttemptsForSameState > 2) {
                log(`No progress after ${reloadAttemptsForSameState} reload attempts with ${buttonsBefore} remaining buttons. Aborting.`);
                break;
            }

            log(`No progress. Recovery reload ${reloadAttemptsForSameState}/2...`);

            const recovered = await recoverPage(page);
            if (!recovered) {
                log('Recovery failed.');
                break;
            }

            await sleep(2000);
        }

        if (safetyCounter >= 500) {
            log('Safety limit reached. Aborting to prevent infinite loop.');
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
                log(`Navigation detected: ${frame.url()}`);
            }
        });

        page.on('domcontentloaded', () => {
            log('DOMContentLoaded event');
        });

        page.on('load', () => {
            log('Load event');
        });

        if (!isLoginMode) {
            await minimizeWindow(page);
        }

        log('Navigating to coupon page...');
        await page.goto('https://www.payback.de/coupons', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });
        log(`Navigation complete. Current URL: ${page.url()}`);

        await sleep(3000);

        if (isLoginMode) {
            log('Login mode active. Please log in manually and then close the browser.');

            page.once('close', async () => {
                log('Browser closed. Session should be saved.');
                try {
                    await context.close();
                } catch {}
            });

            return;
        }

        if (await isOnLoginPage(page)) {
            log('Not logged in. Please run once with --login.');
            showWindowsToast('Payback: Login erforderlich', 'Nicht eingeloggt. Bitte einmal mit --login starten.', true);
            await takeScreenshot(page, 'not-logged-in');
            await context.close();
            return;
        }

        if (!(await isCouponPageLoaded(page))) {
            log('Coupon page did not load as expected.');
            showWindowsToast('Payback: Fehler', 'Coupon-Seite nicht geladen. Screenshot gespeichert.', true);
            await takeScreenshot(page, 'coupon-page-not-ready');
            await context.close();
            return;
        }

        await scrollToLoadAllCoupons(page);

        const headlineStart = await getInactiveCouponCount(page);
        const buttonStart = await getInactiveButtonCount(page);

        log(`Headline count at start: ${headlineStart ?? 'unknown'}`);
        log(`Activatable buttons at start: ${buttonStart}`);

        if (buttonStart === 0) {
            log('No inactive coupons found.');
            showWindowsToast('Payback', 'Keine inaktiven Coupons gefunden.');
            await context.close();
            log('Done');
            return;
        }

        const activated = await activateAllCoupons(page);
        log(`Total activated: ${activated}`);

        const headlineEnd = await getInactiveCouponCount(page);
        const buttonEnd = await getInactiveButtonCount(page);

        log(`Remaining according to headline: ${headlineEnd ?? 'unknown'}`);
        log(`Remaining activatable buttons in DOM: ${buttonEnd}`);

        if (buttonEnd > 0) {
            log('WARNING: There are still activatable buttons remaining.');
            showWindowsToast('Payback: Warnung', `${activated} aktiviert, noch ${buttonEnd} nicht aktivierbar.`, true);
        } else {
            showWindowsToast('Payback', `${activated} Coupon(s) aktiviert.`);
        }

        await sleep(1500);
        await context.close();
        log('Done');
    } catch (err) {
        log(`FATAL: ${err.message}`);
        showWindowsToast('Payback: Fataler Fehler', err.message, true);

        if (page) {
            await takeScreenshot(page, 'fatal');
        }

        if (context) {
            try {
                await context.close();
            } catch {}
        }
    } finally {
        if (!isLoginMode) {
            releaseLock();
        }
        log('------------------------------------------------------');
    }
})();
