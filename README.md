# Payback Coupon Auto Activation

Automatisiertes Aktivieren aller PAYBACK Coupons mittels Playwright.

Das Script öffnet die PAYBACK Coupon-Seite, lädt alle verfügbaren Coupons und aktiviert automatisch alle noch nicht aktivierten Angebote.

---

## 🚀 Features

- Automatisches Aktivieren aller Coupons
- Persistente Login-Session (kein erneutes Login notwendig)
- Logging mit Zeitstempel
- Screenshot bei Fehlern
- Unterstützung für Lazy Loading (Scroll-Automatik)
- Ausführung im Hintergrund (kein störendes CMD-Fenster)
- Windows Aufgabenplanung Integration

---

## 📦 Voraussetzungen

- Node.js installiert  
  → https://nodejs.org/

- Playwright installiert:

```bash
npm install playwright
npx playwright install
```

---

## 📁 Projektstruktur

PaybackCouponActivation/
│
├── payback.js              # Hauptscript
├── run_hidden.vbs          # Startscript (unsichtbar)
├── user-data/              # Browserprofil (automatisch erstellt)
├── screenshots/            # Fehler-Screenshots
├── payback.log             # Logfile
└── README.md

---

## 🔐 Login (einmalig erforderlich)

Beim ersten Start muss man sich manuell einloggen.

### Login starten:

```bash
node payback.js --login
```

### Ablauf:

1. Browser öffnet sich
2. Manuell bei PAYBACK einloggen
3. Browser schließen

→ Login-Session wird im Ordner `user-data` gespeichert

---

## ⚙️ Normaler Betrieb

```bash
node payback.js
```

Das Script:

1. Öffnet PAYBACK
2. Prüft Login
3. Scrollt durch alle Coupons
4. Aktiviert alle nicht aktivierten Coupons
5. Beendet sich automatisch

---

## 🧠 Logik im Script

### Zustände:

| Zustand | Verhalten |
|--------|----------|
| Nicht eingeloggt | Screenshot + Abbruch |
| Keine Coupons verfügbar | Sauberer Exit |
| Coupons vorhanden | Aktivierung |
| Fehler | Screenshot + Log |

---

## 🪟 Hintergrundausführung (ohne Konsole)

### run_hidden.vbs

```vbscript
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d C:\Users\iphar\Documents\PaybackCouponActivation && ""C:\Program Files\nodejs\node.exe"" payback.js", 0, False
```

---

## ⏰ Automatisierung (Windows Aufgabenplanung)

### 03:00 Uhr

```cmd
schtasks /create ^
 /tn "PaybackCoupons_03" ^
 /tr "wscript.exe "C:\Users\iphar\Documents\PaybackCouponActivation\run_hidden.vbs"" ^
 /sc daily ^
 /st 03:00 ^
 /ru "%USERNAME%" ^
 /f
```

### 15:00 Uhr

```cmd
schtasks /create ^
 /tn "PaybackCoupons_15" ^
 /tr "wscript.exe "C:\Users\iphar\Documents\PaybackCouponActivation\run_hidden.vbs"" ^
 /sc daily ^
 /st 15:00 ^
 /ru "%USERNAME%" ^
 /f
```

---

## 🧪 Testlauf

```cmd
schtasks /run /tn "PaybackCoupons_15"
```

---

## 📋 Logs

logs/payback-YYYY-MM-DD.log (tägliche Datei, die letzten 5 Tage werden behalten)

---

## 📸 Screenshots

screenshots/

---

## ⚠️ Einschränkungen

- Benutzer muss angemeldet sein
- Rechner darf nicht im Standby sein
- Login-Session kann ablaufen

---

## 🧯 Troubleshooting

### Nicht eingeloggt
→ node payback.js --login

### Script hängt
→ user-data löschen und neu einloggen

---

## 🧼 Reset

1. user-data löschen
2. node payback.js --login
3. neu einloggen

---

## 📌 Fazit

Saubere, wartbare Automatisierung ohne unnötige Komplexität.
