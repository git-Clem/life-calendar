# Unused resources and dead-code audit

Date: 2026-10-20. Original scan: 314 tracked files; parsed 240 JavaScript, JSX, MJS and TypeScript modules with no syntax errors. The findings below record the pre-cleanup state. iOS Pods were kept.

## Cleanup applied

- Removed the five unused assets, Legend, empty App.css, orphan AdminSecrets panel and useAdminSecrets hook.
- Removed the orphan web admin request helpers and API wrappers. Kept clearAdminToken for logout; backend admin routes and mobile admin UI are unchanged.
- Removed the four unused direct dependencies and their now-unused transitive @dnd-kit/accessibility package. Refreshed the lockfile without changing any remaining package records.
- Removed legacy password-key/verification functions and their private helpers from web/mobile crypto.js; removed unused duplicate web envelope field-encryption helpers and recovery-code regeneration helper.
- Removed unused isEventPastDue wrappers, mobile MAP_PROVIDERS and useApp, and unused stopScheduler. Active event-end calculations, map behavior, context and scheduler remain.
- Kept intentionally parked marketing pages, shared category exports, mobile recovery code and streak-notification code. Kept other API wrappers and maintenance scripts for later review.
- Restored dependencies with npm ci. No native code, Pods, category IDs, stored-data formats, or active crypto function bodies were changed.

### Verification after cleanup

| Check | Result |
|---|---|
| Full npm test | Passed: 152 tests, including four new stored-field compatibility tests. |
| Full npm run lint | Passed: zero errors; 31 warnings, all in unchanged files. |
| Full npm run build | Passed, including production PWA/service-worker generation. Existing large-chunk and plugin-timing warnings remain. |
| iOS and Android production JavaScript bundles | Passed via Expo export for both platforms, without Hermes bytecode, output under /tmp. Native binaries/device runs were not tested. |
| Cross-platform encryption smoke | Passed: real mobile/web implementations, envelope password unlock, field encryption both directions, JSON records, wrong-key handling, legacy plaintext, recovery and password rewrap. Node supplied the random-values global in place of the device polyfill for this check. |
| Export smoke | Passed: real CSV, JSON and browser jsPDF exports with summary and day rows. Download handlers were intercepted to inspect outputs. |
| Desktop configuration | cargo metadata --no-deps and tauri info passed; no native desktop binary rebuild was needed for these JavaScript-only changes. |
| Dependency consistency | npm ls --depth=0 passed; remaining lockfile package records are unchanged. |
| Source review | Retained exported crypto function bodies exactly match their pre-cleanup versions. git diff --check passes. |

The folder now uses about 1.4 GiB on disk: roughly 612 MiB of restored node_modules plus 856 MiB of preserved Pods. src-tauri remains about 1.1 MiB. Restoring offloaded dependencies accounts for the increase from the earlier 866 MiB reading; the Rust target directory was not rebuilt.

## Original audit result

There is real unused code, but it did not cause the original 5+ GB footprint. The clearest unused components and assets total 71,427 bytes (about 70 KiB). Native build output caused the large disk use.

The audit traced static imports, literal dynamic imports, requires, re-exports and shared workspace subpaths from web, mobile, server, scripts, configs and tests. Findings were checked against manifests, service-worker configuration, routes, package scripts, CI and text references. A missing import alone was not treated as proof that a framework resource or dependency was unused.

This is a source audit, not runtime coverage or proof that external clients never use an API. No remote deployments, production data or native builds were inspected.

## 1. Clear unused files and resources

These have no current runtime entry path or asset reference in the tracked project.

| File | Bytes | Evidence |
|---|---:|---|
| `src/components/AdminSecrets.jsx` | 18,320 | No imports or render sites. Its only project dependency is the unused hook below. |
| `src/hooks/useAdminSecrets.js` | 4,170 | Imported only by the unmounted AdminSecrets component. |
| `src/components/Legend.jsx` | 467 | No imports or render sites; other legends are implemented inline. |
| `src/assets/hero.png` | 13,057 | No source, stylesheet or config references. |
| `src/assets/react.svg` | 4,126 | Unreferenced template asset. |
| `src/assets/vite.svg` | 8,709 | Unreferenced template asset. |
| `public/icons.svg` | 5,031 | Unreferenced SVG symbol sprite; no consuming use elements were found. Vite copies public assets, and the current Workbox glob can precache this file. |
| `mobile/assets/splash-icon.png` | 17,547 | No source or app.json reference. app.json does not configure this image as a splash asset. |

The server admin routes are still mounted. The mobile Settings screen has its own active admin UI. Removing the orphan web component would not justify deleting the backend routes or Infisical integration. If the web admin panel is intended to remain a feature, reconnect it instead.

`src/App.css` is empty and unimported: remove for tidiness, with no meaningful space saving.

## 2. Intentionally parked features and duplicate definitions

- `src/main.jsx:19` sets `LANDING_PAGE_ENABLED = false`. Root starts with entered=true and never sets it false, so the marketing routes cannot be reached through the current app entry.
- The landing router and its directory contain 13 JSX files, 842 lines, and 43,323 source bytes. Comments explicitly say they were kept for re-enabling. Treat them as parked, not accidental leftovers.
- All direct `react-router-dom` imports are in those landing modules. Removing that dependency only makes sense if those pages are retired. A successful production build is still needed to measure any bundle savings.
- `shared/categories.js` and `shared/index.js` have no current app consumers. Web uses `src/lib/constants.js`; mobile duplicates categories in `mobile/src/lib/utils.js`. The shared root and categories subpath are declared package exports, so either consolidate callers onto them or retire those exports deliberately. Keep category IDs stable.
- Keep `shared/parseEvents.js`, `shared/peopleSuggestions.js` and the shared workspace dependency: both apps use the shared package or its source paths.

## 3. Unused helpers versus unfinished features

The following helper bodies have no current callers in this checkout:

| Location | Helpers | Suggested treatment |
|---|---|---|
| `src/lib/crypto.js` | generateSalt, deriveKey, generateVerifyBlob, verifyKey | Legacy password-key helpers. Their private hexToBytes helper and PBKDF2/verification constants become removable with them. Keep encryptField, decryptField and the failure placeholder: current data paths use them. |
| `mobile/src/lib/crypto.js` | generateSalt, deriveKey, generateVerifyBlob, verifyKey | Same legacy helpers. PBKDF2 imports and helper-only constants can then be removed here; the separate mobile envelope implementation still needs its own PBKDF2 code. |
| `src/lib/zkEnvelope.js` | rewrapForRecovery, encryptField, decryptField | No callers. Active record encryption uses crypto.js, not these prefixed field helpers. Keep active envelope wrapping and recovery/login code. |
| `mobile/src/lib/utils.js:118`, `src/lib/utils.js:190` | isEventPastDue | No callers; getEventEndDateTime is used directly elsewhere and must stay. |
| `mobile/src/lib/handoffActions.js:3` | MAP_PROVIDERS | No references. buildMapUrl and map-opening behavior remain used. |
| `mobile/src/context/AppContext.js:4` | useApp | No callers; consumers call useContext(AppContext) directly. Keep AppContext and its Provider. |
| `server/services/notificationService.js:400` | stopScheduler | No callers; could be retained and wired into shutdown instead of removed. |

Two groups should be reviewed as feature gaps before removing them:

- **Streak notifications:** `checkStreakMilestone` at notificationService.js:374 has no imports/callers. Its comment says the habits route calls it, but server/routes/habits.js does not. integrations.js:95 accepts streak_milestone schedules, while the scheduler handles only event_reminder, habit_reminder and daily_summary. The current checked-in path does not dispatch streak milestones. Repair the feature or retire its API option and unused function together.
- **Mobile password recovery:** deriveRecoveryVerifier, unlockWithRecovery and rewrapForPassword in mobile/src/lib/zkEnvelope.js have no callers. Mobile API recoveryEnvelope/resetPassword wrappers are also unused. The app generates and displays a recovery code on registration, but has no checked-in recovery reset flow using these helpers. Web recovery is active and must stay. Prefer deciding whether to finish mobile recovery before deleting its pieces.

## 4. Dependencies

Clear direct dependency cleanup candidates in root package.json:

- @dnd-kit/core
- @dnd-kit/sortable
- @dnd-kit/utilities
- @tauri-apps/plugin-updater (the JavaScript package)

There are no source, script, config or CI imports of these packages. CalendarGrid implements drag handling through pointer events. Desktop updating invokes Rust commands through @tauri-apps/api/core; the Rust tauri-plugin-updater dependency and plugin setup are active and must remain. The dnd-kit packages reference one another, so remove the three together and regenerate the lockfile.

Packages that initially look unused but should not be blindly removed:

| Package | Why retain or review |
|---|---|
| @capacitor/android, @capacitor/core, @capacitor/ios, @capacitor/cli | Capacitor config and cap:* scripts remain. This is a second mobile packaging path alongside Expo, not proven dead by lack of imports. |
| canvg, dompurify, html2canvas | jsPDF declares these as optional dependencies and its installed code refers to them. The app uses jsPDF for exports. Removing root declarations may not remove installed or bundled copies; canvg also has different root and jsPDF version ranges. Check PDF/export behavior before changing. |
| expo-linking | expo-share-intent declares it as a dependency and peer dependency. |
| react-native-screens | Peer dependency of @react-navigation/bottom-tabs, which the app uses. |
| expo-dev-client | Native development workflow documented by mobile/AGENTS.md. |
| @pls-calendar/shared | Shared parser and people-suggestion subpaths are imported. |

Separate tooling issue: both icon generator scripts import sharp, but sharp is not declared in package.json or package-lock.json. These are useful maintenance scripts, not dead code. Add an explicit dev dependency if retaining their current implementation.

## 5. Unused client API wrappers

A property-access scan found the following wrappers with no direct app callers. No API aliases or computed api[...] calls were found in the inspected source. Backend endpoints can serve mobile, external clients and manual tools, so these results do not prove that the server routes should be deleted.

### mobile/src/lib/api.js

- `api.health` (line 28)
- `api.auth.recoveryEnvelope` (line 36)
- `api.auth.resetPassword` (line 37)
- `api.auth.setEmail` (line 39)
- `api.auth.setTimezone` (line 40)
- `api.events.replaceBySource` (line 52)
- `api.linkedCalendars.update` (line 63)
- `api.habits.update` (line 69)
- `api.profile.get` (line 76)
- `api.categoryKeywords.get` (line 86)
- `api.llmSettings.get` (line 90)

### src/lib/api.js

- `api.auth.setTimezone` (line 60)
- `api.admin.listUsers` (line 78)
- `api.admin.resetPassword` (line 79)
- `api.admin.setBlocked` (line 80)
- `api.admin.deleteUser` (line 81)
- `api.admin.auditLog` (line 82)
- `api.admin.signupClusters` (line 83)
- `api.admin.rotateSecret` (line 90)
- `api.admin.storeAdminToken` (line 93)
- `api.admin.hasAdminToken` (line 95)
- `api.events.delete` (line 106)
- `api.events.replaceBySource` (line 108)
- `api.events.replaceBySourceCalendar` (line 109)
- `api.integrations.list` (line 162)
- `api.integrations.listSchedules` (line 167)
- `api.push.expoToken` (line 177)
- `api.categoryKeywords.get` (line 186)
- `api.llmSettings.get` (line 190)
- `api.appearance.get` (line 195)

The web admin wrappers used only by useAdminSecrets are also unreachable through the current web entry, even though they have a syntactic caller. clearAdminToken is still called from useAuth; keep that behavior if pruning admin UI helpers. Several unused GET wrappers have been replaced in practice by startup /sync snapshots.

## 6. Export-only cleanup

The following exports have no external import consumers found in this checkout, but their declarations are still used inside their own files. Remove the export keyword if desired; do not delete the underlying code. Config default exports are excluded because their tools load them directly. Declared package entry exports require separate review.

- `mobile/src/lib/calendarUtils.js:2` — `timeToSlot`
- `mobile/src/lib/calendarUtils.js:8` — `addDayStr`
- `mobile/src/lib/contactPicker.js:16` — `normalizeContact`
- `mobile/src/lib/handoffActions.js:10` — `buildMapUrl`
- `mobile/src/lib/theme.js:3` — `LIGHT`
- `mobile/src/lib/theme.js:35` — `DARK`
- `mobile/src/lib/zkEnvelope.js:16` — `generateSalt`
- `server/lib/pbClient.js:98` — `PB_BASE`
- `server/routes/auth.js:41` — `makeToken`
- `server/services/notificationService.js:404` — `dispatchToIntegration`
- `src/components/landing/shared.jsx:5` — `GITHUB_REPO`
- `src/hooks/useAppearance.js:35` — `DEFAULT_APPEARANCE`
- `src/hooks/useAppearance.js:57` — `normalize`
- `src/hooks/useTheme.js:22` — `DEFAULT_CUSTOM`
- `src/hooks/useTheme.js:40` — `derivePalette`
- `src/lib/calendarUtils.js:16` — `addDayStr`
- `src/lib/crypto.js:119` — `isBase64`
- `src/lib/parsedEventDrafts.js:18` — `draftToEvents`
- `src/lib/platform.js:12` — `isCapacitor`
- `src/lib/platform.js:20` — `isNativeApp`
- `src/lib/zkEnvelope.js:51` — `generateSalt`
- `src/lib/zkEnvelope.js:88` — `generateDEK`
- `src/lib/zkEnvelope.js:114` — `generateRecoveryCode`
- `src/lib/zkEnvelope.js:125` — `normalizeRecoveryCode`
- `src/lib/zkEnvelope.js:251` — `isCiphertext`

## 7. Resources deliberately retained

- public/sw-push.js: loaded through VitePWA workbox.importScripts, despite having no JS importer.
- PocketBase migrations and entrypoint scripts: loaded by the database/runtime or container, not the web import graph.
- Mobile icons and favicon: referenced in mobile/app.json.
- Desktop .icns/.ico and configured PNG icons: consumed by Tauri packaging.
- Other generated desktop icon variants: no explicit project references were found for several Windows/Square icons and 64x64.png; leave them until native bundling confirms which files it discovers implicitly.
- CSS classes built from settings values: dynamic class composition prevents safely declaring every selector unused from a text search. pt-safe and pb-safe-6 have no current consumers; the other named safe-area classes do.
- Tests and maintenance scripts: valid entry points even without app imports.

## 8. Original audit checks and limits

- Parsed all 240 tracked JS/JSX/MJS/TS modules successfully; no unresolved relative imports found in that graph.
- Passed 77 tests with: node --test --test-concurrency=16 --test-timeout=15000 src/lib/*.test.js mobile/src/lib/*.test.mjs shared/peopleSuggestions.test.js
- Full npm test started but stalled in the chrono-node parser tests. npm run lint and a Vite build to a temporary output directory also stalled. These attempts were stopped; they are not reported as passes or test failures.
- macOS marks inspected node_modules files, including eslint/lib/api.js and chrono-node/dist/cjs/index.js, as compressed,dataless. Offloaded dependency files are a likely cause of the stalls, not a proven diagnosis. Dependency installation was not changed.
- No full native build was run, to avoid recreating the large Rust build directory.
- The temporary import/reference analysis was conservative around dynamic imports, namespace imports and exports. Reachability does not establish that every branch or exported object property is used. Other inactive paths may remain.

## Original recommended cleanup order

1. Remove the five unreferenced assets, orphan Legend, and empty App.css.
2. Remove or reconnect the orphan web admin panel and hook; preserve backend/mobile admin behavior.
3. Remove the four unused direct dependencies and refresh the lockfile.
4. Remove legacy helper bodies and private dependencies that become unused, while keeping active field encryption compatible with stored data.
5. Decide whether to repair streak notifications and mobile recovery; keep intentionally parked landing code unless it is being retired.
6. Restore locally available dependencies, then rerun full lint, tests, web build, and relevant native/export smoke checks before shipping cleanup.
