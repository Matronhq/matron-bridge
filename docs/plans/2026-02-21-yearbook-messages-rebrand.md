# Yearbook Messages Comprehensive Rebrand Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fully rebrand forked Element apps as "Yearbook Messages" — remove all Element/Riot/Vector branding, replace icons, lock to our homeserver, and make it look like a standalone app.

**Architecture:** Config-driven branding where possible (Element reads `brand` from config.json), asset replacement for icons/logos, source code changes for hardcoded references.

**Tech Stack:** TypeScript/React (element-web), TypeScript/Electron (element-desktop), Swift/SwiftUI (element-x-ios)

**Already done:** Basic config.json, build.json, server picker hiding, logo replacement for auth header/app icon. This plan covers everything remaining.

---

## Phase 1: Element Web — Complete Rebrand

### Task 1: HTML meta tags and page title

**Files:**
- Modify: `/home/danbarker/element-web-fork/src/vector/index.html`

Find and replace:
- `<title>Element</title>` → `<title>Yearbook Messages</title>`
- `<meta name="apple-mobile-web-app-title" content="Element">` → `content="Yearbook Messages"`
- `<meta name="application-name" content="Element">` → `content="Yearbook Messages"`
- `Sorry, Element requires JavaScript` → `Sorry, Yearbook Messages requires JavaScript`

**Commit:** `feat: update HTML title and meta tags to Yearbook Messages`

---

### Task 2: PWA manifest

**Files:**
- Modify: `/home/danbarker/element-web-fork/res/manifest.json`

Update:
- `"name": "Element"` → `"name": "Yearbook Messages"`
- `"short_name": "Element"` → `"short_name": "YM"`
- `"theme_color": "#76CFA6"` → `"theme_color": "#F5F0EB"` (cream from logo BG)
- Remove or update Play Store / App Store / F-Droid platform links

**Commit:** `feat: update PWA manifest for Yearbook Messages`

---

### Task 3: Replace favicon and PWA icons

**Files:**
- Replace all PNGs in: `/home/danbarker/element-web-fork/res/vector-icons/`
  - `24.png`, `120.png`, `144.png`, `152.png`, `180.png`, `512.png`, `1024.png`

Use ImageMagick to generate from `/home/danbarker/YM Collapsed Logo Gilroy Black Square Cream BG 1500.png`:
```bash
SRC="$HOME/YM Collapsed Logo Gilroy Black Square Cream BG 1500.png"
for size in 24 120 144 152 180 512 1024; do
  convert "$SRC" -resize ${size}x${size} "res/vector-icons/${size}.png"
done
```

**Commit:** `feat: replace PWA and favicon icons with YM logo`

---

### Task 4: Replace remaining Element logo images

**Files:**
- Replace: `res/img/element-shiny.svg` — used in some UI elements
- Replace: `res/img/element-desktop-logo.svg` — referenced in desktop download prompts

For SVG, create a simple wrapper that embeds the PNG:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="148" height="148">
  <image href="themes/element/img/logos/yearbook-messages-logo.png" width="148" height="148"/>
</svg>
```

Or replace references to point to the PNG directly.

**Commit:** `feat: replace remaining Element logo SVGs`

---

### Task 5: Remove Element-specific config references

**Files:**
- Modify: `/home/danbarker/element-web-fork/element.io/app/config.json`
- Modify: `/home/danbarker/element-web-fork/element.io/develop/config.json`

Remove or neutralize:
- `integrations_ui_url` / `integrations_rest_url` / `integrations_widgets_urls` (scalar.vector.im)
- `bug_report_endpoint_url` (rageshakes.element.io)
- `posthog` analytics block
- `privacy_policy_url` and `terms_and_conditions_links` (element.io URLs)
- `element_call` block (call.element.io)
- `map_style_url` (maptiler API key)

These services are Element-hosted and won't work for our fork. Remove them to avoid broken integrations.

**Commit:** `feat: remove Element-hosted service references from configs`

---

### Task 6: Update package.json

**Files:**
- Modify: `/home/danbarker/element-web-fork/package.json`

Update:
- `"name"` → `"yearbook-messages-web"`
- `"description"` → `"Yearbook Messages web client"`

**Commit:** `chore: update package.json name and description`

---

### Task 7: Build and verify

Build element-web:
```bash
cd ~/element-web-fork && npx nx build
```

Open dev server and verify:
- Page title says "Yearbook Messages"
- Favicon is YM logo
- Login screen shows YM branding
- No "Element" text visible on login, home, or settings pages
- About dialog shows "Yearbook Messages"

**Commit any fixes.**

---

## Phase 2: Element Desktop — Complete Rebrand

### Task 8: Update nightly build variant

**Files:**
- Modify: `/home/danbarker/element-desktop-fork/element.io/nightly/build.json`

Update to match release variant pattern:
```json
{
    "appId": "be.yearbooks.messages.nightly",
    "name": "yearbook-messages-nightly",
    "productName": "Yearbook Messages Nightly",
    "description": "Yearbook Messages (Nightly)",
    "protocols": ["yearbook-messages-nightly"]
}
```

**Commit:** `feat: update nightly build variant branding`

---

### Task 9: Update desktop config files

**Files:**
- Modify: `/home/danbarker/element-desktop-fork/element.io/release/config.json`
- Modify: `/home/danbarker/element-desktop-fork/element.io/nightly/config.json`

Replace with our config (locked to homeserver, no Element services):
```json
{
    "default_server_config": {
        "m.homeserver": {
            "base_url": "https://matrix-dev2.yearbooks.be",
            "server_name": "matrix-dev2.yearbooks.be"
        }
    },
    "disable_custom_urls": true,
    "disable_guests": true,
    "brand": "Yearbook Messages",
    "branding": {
        "auth_header_logo_url": "themes/element/img/logos/yearbook-messages-logo.png"
    },
    "default_federate": false,
    "default_theme": "light",
    "show_labs_settings": false
}
```

**Commit:** `feat: update desktop config files with Yearbook Messages branding`

---

### Task 10: Update source code fallback strings

**Files:**
- Modify: `/home/danbarker/element-desktop-fork/src/electron-main.ts`
- Modify: `/home/danbarker/element-desktop-fork/src/auto-launch.ts`
- Modify: `/home/danbarker/element-desktop-fork/src/vectormenu.ts`
- Modify: `/home/danbarker/element-desktop-fork/src/store.ts`

Replace all `|| "Element"` fallbacks with `|| "Yearbook Messages"`.

Also update:
- `src/webcontents-handler.ts`: Change default `web_base_url` from `https://app.element.io/` to our URL
- `src/vectormenu.ts`: Update help URL from `https://element.io/help`

**Commit:** `feat: update all Element fallback strings to Yearbook Messages`

---

### Task 11: Update macOS iconset properly

**Files:**
- Modify: `/home/danbarker/element-desktop-fork/build/icon.icon/icon.json`

The icon.json references `"image-name": "element.png"`. Either:
- Rename `Assets/element.png` → `Assets/yearbook.png` and update icon.json
- Or just keep the filename (it's already been replaced with YM content)

**Commit:** `feat: update macOS iconset configuration`

---

### Task 12: Build and verify desktop

```bash
cd ~/element-desktop-fork
pnpm run build:ts && pnpm run build:res
bash scripts/use-local-webapp.sh ../element-web-fork
pnpm start
```

Verify:
- App title bar says "Yearbook Messages"
- Dock icon is YM logo
- Menu bar shows "Yearbook Messages"
- About dialog shows correct branding
- Help menu links are correct or removed

---

## Phase 3: Element X iOS — Complete Rebrand

### Task 13: Update project-level configuration

**Files:**
- Modify: `/home/danbarker/element-x-ios-fork/project.yml`
- Modify: `/home/danbarker/element-x-ios-fork/app.yml`

In `project.yml`:
- `name: ElementX` → `name: YearbookMessages`
- `ORGANIZATIONNAME: Element` → `ORGANIZATIONNAME: Yearbook`
- `APP_NAME: ElementX` → `APP_NAME: YearbookMessages`

In `app.yml`:
- `APP_DISPLAY_NAME: Element X` → `APP_DISPLAY_NAME: Yearbook Messages`
- `PRODUCTION_APP_NAME: Element` → `PRODUCTION_APP_NAME: Yearbook Messages`
- `APP_GROUP_IDENTIFIER: group.io.element` → `group.be.yearbooks.messages`
- `BASE_BUNDLE_IDENTIFIER: io.element.elementx` → `be.yearbooks.messages`

**Commit:** `feat: update iOS project configuration for Yearbook Messages`

---

### Task 14: Update Info.plist and entitlements

**Files:**
- Modify: `ElementX/SupportingFiles/Info.plist`
- Modify: `ElementX/SupportingFiles/ElementX.entitlements`
- Modify: `NSE/SupportingFiles/Info.plist`
- Modify: `NSE/SupportingFiles/NSE.entitlements`
- Modify: `ShareExtension/SupportingFiles/ShareExtension.entitlements`

Update all `io.element.elementx` references to `be.yearbooks.messages`.

**Commit:** `feat: update iOS bundle identifiers and entitlements`

---

### Task 15: Update hardcoded strings in source

**Files:**
- Modify: `ElementX/Sources/Application/Settings/AppSettings.swift`
  - Update `elementWebHosts` to yearbook domains
  - Update `io.element.elementx.nightly` bundle ID
  - Update `io.element.elementx.background.refresh` task ID
- Modify: `NSE/Sources/NotificationServiceExtension.swift`
  - Update notification identifier
- Modify: `ElementX/Sources/Screens/CallScreen/View/CallScreen.swift`
  - Update `clientID` from `io.element.elementx`

**Commit:** `feat: update hardcoded Element identifiers in iOS source`

---

### Task 16: Replace app icons

**Files:**
- Replace icons in: `ElementX/Resources/Assets.xcassets/AppIcon.appiconset/`

Generate all required sizes from the YM logo using a script or manually in Xcode.

**Commit:** `feat: replace iOS app icons with YM logo`

---

### Task 17: Update URL schemes

**Files:**
- Modify: `ElementX/SupportingFiles/target.yml`

Update:
- `io.element.call` URL scheme → `be.yearbooks.messages.call`
- `applinks:app.element.io` → remove or update

**Commit:** `feat: update iOS URL schemes for Yearbook Messages`

---

### Task 18: Build and verify iOS

Open in Xcode, build for simulator, verify:
- App name shows "Yearbook Messages" on home screen
- Launch screen has no Element branding
- Settings/About shows "Yearbook Messages"
- Login screen matches web version (no homeserver picker, YM branding)

---

## Phase 4: Documentation cleanup (optional, low priority)

### Task 19: Update READMEs

Update README.md in all three repos to describe "Yearbook Messages" rather than Element. This is cosmetic and can be deferred.

**Commit:** `docs: update README for Yearbook Messages`
