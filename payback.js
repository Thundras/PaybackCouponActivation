const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

(async () => {
    const isLoginMode = process.argv.includes('--login');
    const isDryRunMode = process.argv.includes('--dry-run');
    const userDataDir = path.resolve('./user-data');
    const logDir = path.resolve('./logs');
    const logFile = path.join(logDir, `payback-${new Date().toISOString().slice(0, 10)}.log`);
    const screenshotDir = path.resolve('./screenshots');
    const lockFile = path.resolve('./payback.lock');

    // --- Tuning parameters ---
    const SAFETY_LIMIT                       = 500;
    const NO_PROGRESS_STREAK_LIMIT           = 5;
    const RATE_LIMIT_STREAK_LIMIT            = 3;
    const MAX_RELOAD_ATTEMPTS                = 2;
    const LOG_RETENTION_DAYS                 = 5;
    const SCROLL_STABLE_ROUNDS_REQUIRED      = 3;
    const MAX_SCROLL_ATTEMPTS                = 60;
    const PERIODIC_PAUSE_EVERY_N_ACTIVATIONS = 20;

    // --- Timing (milliseconds) ---
    const RATE_LIMIT_BACKOFF_MS          = 90_000;
    const PERIODIC_PAUSE_DURATION_MS     = 8_000;
    const NAVIGATION_TIMEOUT_MS          = 30_000;
    const PAGE_RELOAD_TIMEOUT_MS         = 30_000;
    const BUTTON_CLICK_TIMEOUT_MS        = 5_000;
    const DIALOG_CLOSE_TIMEOUT_MS        = 3_000;
    const TOAST_TIMEOUT_MS               = 5_000;
    const POST_NAVIGATION_DELAY_MS       = 3_000;
    const POST_RELOAD_DELAY_MS           = 3_000;
    const POST_CLICK_EXTENDED_DELAY_MS   = 4_000;
    const POST_CLICK_DELAY_MS            = 2_500;
    const DOM_DETACH_RECOVERY_DELAY_MS   = 2_000;
    const PRE_RECOVERY_DELAY_MS          = 2_000;
    const POST_PROGRESS_DELAY_MS         = 1_000;
    const DIALOG_CLOSE_DELAY_MS          = 1_000;
    const SCROLL_STEP_DELAY_MS           = 1_500;
    const SCROLL_END_DELAY_MS            = 1_000;
    const PRE_CLOSE_DELAY_MS             = 1_500;
    const SCREENSHOT_RESTORE_DELAY_MS    = 300;

    // --- Selectors ---
    const SELECTOR_INACTIVE_BUTTON = 'button[data-testid$="-not_activated"]';
    const SELECTOR_COUPON_HEADLINE = '[data-testid="not-activated-coupons-headline"]';
    const SELECTOR_PARTNER_FILTER  = '[data-testid="coupons-partner-filter-select"]';

    // --- URLs and text ---
    const PAYBACK_COUPON_URL       = 'https://www.payback.de/coupons';
    const TEXT_SERVICE_UNAVAILABLE = 'Dieser Service steht derzeit leider nicht zur Verfügung';
    const ERROR_MSG_DOM_DETACH     = 'detached from the DOM';

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
            .slice(LOG_RETENTION_DAYS);
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

    if (!isLoginMode && !isDryRunMode) {
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
     * - persistent=true: alarm toast with OK button (stays on screen until dismissed).
     * @param {string} title - Notification title.
     * @param {string} message - Notification body.
     * @param {boolean} persistent - true = alarm scenario (stays until dismissed).
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
        // Synchronous execution: ensures PowerShell completes before Node continues.
        // spawn/detach does not work reliably on Windows — spawned processes are killed
        // when the parent Node process exits before they finish starting up.
        try {
            execFileSync('powershell', ['-NonInteractive', '-EncodedCommand', encoded], { timeout: TOAST_TIMEOUT_MS });
        } catch {
            // Non-fatal: notification failure must never abort the main script.
        }
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
            await sleep(SCREENSHOT_RESTORE_DELAY_MS);
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
            .locator(SELECTOR_PARTNER_FILTER)
            .first()
            .isVisible()
            .catch(() => false);

        const headlineVisible = await page
            .locator(SELECTOR_COUPON_HEADLINE)
            .first()
            .isVisible()
            .catch(() => false);

        return filterVisible || headlineVisible;
    }

    async function getInactiveCouponCount(page) {
        const locator = page.locator(SELECTOR_COUPON_HEADLINE).first();
        const visible = await locator.isVisible().catch(() => false);

        if (!visible) {
            return null;
        }

        const text = ((await locator.textContent()) || '').trim();
        const match = text.match(/\((\d+)\)/);

        return match ? parseInt(match[1], 10) : null;
    }

    async function getInactiveButtonCount(page) {
        return await page.locator(SELECTOR_INACTIVE_BUTTON).count();
    }

    async function scrollToLoadAllCoupons(page) {
        log('Scroll for lazy loading started...');

        let lastHeight = -1;
        let stableRounds = 0;
        let scrollAttempts = 0;

        while (stableRounds < SCROLL_STABLE_ROUNDS_REQUIRED && scrollAttempts < MAX_SCROLL_ATTEMPTS) {
            scrollAttempts++;
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await sleep(SCROLL_STEP_DELAY_MS);

            const newHeight = await page.evaluate(() => document.body.scrollHeight);

            if (newHeight === lastHeight) {
                stableRounds++;
            } else {
                stableRounds = 0;
                lastHeight = newHeight;
            }
        }

        if (scrollAttempts >= MAX_SCROLL_ATTEMPTS) {
            log(`Scroll timeout reached (${MAX_SCROLL_ATTEMPTS * SCROLL_STEP_DELAY_MS / 1000}s). Proceeding with coupons loaded so far.`);
        }

        await page.evaluate(() => window.scrollTo(0, 0));
        await sleep(SCROLL_END_DELAY_MS);

        log('Scroll for lazy loading completed.');
    }

    async function isServiceUnavailableDialogOpen(page) {
        return await page
            .getByText(TEXT_SERVICE_UNAVAILABLE, { exact: false })
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
            await closeButton.click({ timeout: DIALOG_CLOSE_TIMEOUT_MS });
            await sleep(DIALOG_CLOSE_DELAY_MS);
            return true;
        } catch {
            return false;
        }
    }

    async function recoverPage(page) {
        log('Recovery: reloading page...');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: PAGE_RELOAD_TIMEOUT_MS });
        await sleep(POST_RELOAD_DELAY_MS);

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

        while (safetyCounter < SAFETY_LIMIT) {
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

            if (noProgressStreak >= NO_PROGRESS_STREAK_LIMIT) {
                if (await isOnLoginPage(page)) {
                    log('Session expired mid-run (detected via noProgressStreak). Please run with --login.');
                    showWindowsToast('Payback: Session abgelaufen', 'Session ist während des Laufs abgelaufen. Bitte mit --login neu einloggen.', true);
                } else {
                    log(`No progress for ${buttonsBefore} remaining buttons. Aborting.`);
                }
                break;
            }

            const button = page.locator(SELECTOR_INACTIVE_BUTTON).first();
            let progressed = false;
            // Tracks a clean failure: click executed without error or service dialog, but coupon did not activate.
            // Used to detect PAYBACK-side rate limiting distinct from DOM/network errors.
            let cleanFailure = false;

            try {
                await button.click({ timeout: BUTTON_CLICK_TIMEOUT_MS });

                await sleep(POST_CLICK_DELAY_MS);

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
                    await sleep(POST_CLICK_EXTENDED_DELAY_MS);

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

                if (msg.includes(ERROR_MSG_DOM_DETACH)) {
                    await sleep(DOM_DETACH_RECOVERY_DELAY_MS);

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
                await sleep(POST_PROGRESS_DELAY_MS);

                if (activated > 0 && activated % PERIODIC_PAUSE_EVERY_N_ACTIVATIONS === 0) {
                    log('Short pause to reduce load...');
                    await sleep(PERIODIC_PAUSE_DURATION_MS);
                }

                continue;
            }

            if (cleanFailure) {
                rateLimitStreak++;
                if (rateLimitStreak >= RATE_LIMIT_STREAK_LIMIT) {
                    log(`Rate limit suspected. Backing off for ${RATE_LIMIT_BACKOFF_MS / 1000} seconds...`);
                    await sleep(RATE_LIMIT_BACKOFF_MS);
                    rateLimitStreak = 0;
                    noProgressStreak = 0;
                    continue;
                }
            }

            reloadAttemptsForSameState++;

            if (reloadAttemptsForSameState > MAX_RELOAD_ATTEMPTS) {
                log(`No progress after ${reloadAttemptsForSameState} reload attempts with ${buttonsBefore} remaining buttons. Aborting.`);
                break;
            }

            log(`No progress. Recovery reload ${reloadAttemptsForSameState}/${MAX_RELOAD_ATTEMPTS}...`);

            const recovered = await recoverPage(page);
            if (!recovered) {
                if (await isOnLoginPage(page)) {
                    log('Session expired mid-run (detected via recovery). Please run with --login.');
                    showWindowsToast('Payback: Session abgelaufen', 'Session ist während des Laufs abgelaufen. Bitte mit --login neu einloggen.', true);
                } else {
                    log('Recovery failed.');
                }
                break;
            }

            await sleep(PRE_RECOVERY_DELAY_MS);
        }

        if (safetyCounter >= SAFETY_LIMIT) {
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
        await page.goto(PAYBACK_COUPON_URL, {
            waitUntil: 'domcontentloaded',
            timeout: NAVIGATION_TIMEOUT_MS
        });
        log(`Navigation complete. Current URL: ${page.url()}`);

        await sleep(POST_NAVIGATION_DELAY_MS);

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

        if (isDryRunMode) {
            const countLabel = headlineStart != null ? `${headlineStart} (headline) / ${buttonStart} (DOM)` : `${buttonStart} (DOM)`;
            log(`Dry-run: ${countLabel} inactive coupon(s) found. No activation performed.`);
            showWindowsToast('Payback Dry-Run', `${buttonStart} inaktive Coupon(s) gefunden. Keine Aktivierung.`);
            await context.close();
            log('Done');
            return;
        }

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

        await sleep(PRE_CLOSE_DELAY_MS);
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
        if (!isLoginMode && !isDryRunMode) {
            releaseLock();
        }
        log('------------------------------------------------------');
    }
})();
