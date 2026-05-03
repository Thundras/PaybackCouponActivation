# Payback Coupon Auto Activation

Automated activation of all PAYBACK coupons using Playwright.

The script opens the PAYBACK coupon page, loads all available coupons, and automatically activates every offer that has not been activated yet.

---

## Features

- Automatic activation of all available coupons
- Persistent login session (no repeated login required)
- Timestamped logging with daily log rotation (5 days retained)
- Screenshots on errors
- Lazy loading support via scroll automation
- Background execution (no visible console window)
- Windows Task Scheduler integration

---

## Prerequisites

- Node.js installed
  → https://nodejs.org/

- Playwright installed:

```bash
npm install playwright
npx playwright install
```

---

## Project Structure

```
PaybackCouponActivation/
│
├── payback.js              # Main script
├── run_hidden.vbs          # Silent launcher
├── user-data/              # Browser profile (created automatically)
├── screenshots/            # Error screenshots
├── logs/                   # Daily log files (payback-YYYY-MM-DD.log)
└── README.md
```

---

## Login (required once)

The first run requires a manual login.

### Start login mode:

```bash
node payback.js --login
```

### Steps:

1. Browser opens
2. Log in to PAYBACK manually
3. Close the browser

→ The session is saved in the `user-data` folder and reused on subsequent runs.

---

## Normal Operation

```bash
node payback.js
```

The script:

1. Opens PAYBACK
2. Verifies login state
3. Scrolls through all coupons (handles lazy loading)
4. Activates all inactive coupons
5. Exits automatically

> **Recommendation:** Run the script automatically via Windows Task Scheduler 1–2 times per day. PAYBACK periodically adds large batches of new coupons; running twice daily (e.g. 01:00 and 13:00) ensures they are picked up promptly. See the [Automation](#automation-windows-task-scheduler) section below.

---

## Script Logic

### States:

| State | Behaviour |
|---|---|
| Not logged in | Screenshot + abort |
| No coupons available | Clean exit |
| Coupons found | Activation loop |
| Error | Screenshot + log |

### Termination conditions (activation loop):

| Condition | Description |
|---|---|
| `noProgressStreak >= 5` | Button count unchanged for 5 consecutive iterations |
| `reloadAttemptsForSameState > 2` | 3 failed page reloads without progress |
| `safetyCounter >= 500` | Hard limit as last-resort infinite-loop guard |

---

## Background Execution (no console window)

### run_hidden.vbs

```vbscript
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d C:\Users\iphar\Documents\PaybackCouponActivation && ""C:\Program Files\nodejs\node.exe"" payback.js", 0, False
```

---

## Automation (Windows Task Scheduler)

### 01:00

```cmd
schtasks /create ^
 /tn "PaybackCoupons_01" ^
 /tr "wscript.exe \"C:\Users\iphar\Documents\PaybackCouponActivation\run_hidden.vbs\"" ^
 /sc daily ^
 /st 01:00 ^
 /ru "%USERNAME%" ^
 /f
```

### 13:00

```cmd
schtasks /create ^
 /tn "PaybackCoupons_13" ^
 /tr "wscript.exe \"C:\Users\iphar\Documents\PaybackCouponActivation\run_hidden.vbs\"" ^
 /sc daily ^
 /st 13:00 ^
 /ru "%USERNAME%" ^
 /f
```

---

## Test Run

```cmd
schtasks /run /tn "PaybackCoupons_13"
```

---

## Logs

`logs/payback-YYYY-MM-DD.log` — one file per day, last 5 days retained.

---

## Screenshots

Saved to `screenshots/` on error conditions (not logged in, page not ready, fatal error).

---

## Limitations

- User must be logged in (run `--login` once)
- Machine must not be in standby during scheduled runs
- Login session can expire over time

---

## Known Issues

### Browser window briefly flashes during error screenshots

The browser runs minimized in the background during normal operation. Screenshots are only taken in error scenarios.

Chromium in visible mode (`headless: false`) **cannot capture screenshots from a minimized window** — this is a Chrome DevTools Protocol (CDP) limitation: the rendering pipeline for minimized windows is suspended by the OS, so no image data is available.

As a workaround, the window is temporarily restored to `normal` state before the screenshot and immediately minimized again. This causes a brief visible flash of the browser window.

Using `headless: true` would avoid this, but risks PAYBACK detecting the browser as a bot and blocking it. The deliberate choice is to keep `headless: false`.

---

## Open TODOs

**Medium priority**

_(none)_

**Low priority**

- [ ] **Dry-run mode** (`--dry-run`) — count available coupons without activating them, useful for testing
- [ ] **Pin Playwright version** — change `^1.58.2` to exact version in `package.json` to prevent unexpected behaviour from automatic minor updates

---

## Troubleshooting

### Not logged in
→ `node payback.js --login`

### Script hangs
→ Delete `user-data/` and run `--login` again

---

## Reset

1. Delete `user-data/`
2. `node payback.js --login`
3. Log in manually

---

## Change History

### v1.4.0 — 2026-05-03
- `feature` Mid-run session expiry detection — checks for login page when `noProgressStreak` or recovery fails, shows persistent toast
- `feature` Scroll timeout — `scrollToLoadAllCoupons` aborts after 90s to prevent infinite hang

### v1.3.0 — 2026-05-03
- `feature` Windows toast notifications — success (auto-dismiss) and errors (persistent alarm toast with OK button, stays until dismissed)

### v1.2.0 — 2026-05-03
- `feature` Lock file (`payback.lock`) to prevent concurrent AUTO instances
- `feature` Rate-limit detection — 3 consecutive clean failures trigger a 90s back-off before retrying
- `feature` All log messages translated to English

### v1.1.1 — 2026-05-03
- `bugfix` Screenshot fix: restore window before capture, minimize again after (CDP limitation with minimized windows)

### v1.1.0 — 2026-05-03
- `feature` Daily log rotation — `logs/payback-YYYY-MM-DD.log`, last 5 days retained
- `feature` Safety limit raised from 150 to 500 iterations

### v1.0.0 — 2026-03-20
- `feature` Initial implementation

---

## Summary

Clean, maintainable automation without unnecessary complexity.
