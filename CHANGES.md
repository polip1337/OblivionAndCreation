# UI Overhaul Change Log

## Protected identifier audit (from existing JS)

The following DOM hooks were treated as protected and left intact (no renaming/removal):

- IDs: `saveStatus`, `tutorialHint`, `tutorialBar`, `tutorialDismissBtn`, `tutorialObjective`, `tutorialStepCircle`, `tutorialDots`, `forge-panel`, `cp-counter`, `leftCultivator`, `leftDaos`, `leftTabs`, `cultivatorCompass`, `activeDaoArea`, `activeDaoGrid`, `activeBonusSummary`, `modalRoot`, `winOverlay`, `winPanel`, `winLine1`, `winLine2`, `winLine3`, `beginAgainBtn`, `inventory-filters`, `narrativeBanner`, `inventoryGrid`, `seedGraphTooltip`, `middleForgeTabBtn`, `middleLibraryTabBtn`, `middleSeedsTabBtn`, `middleMasteryTabBtn`, `forgeReason`, `slotA`, `slotB`, `resonance-indicator`, `forgeBtn`, `knownForgeResult`, `forgeCost`, `recentFeed`, `infoPanelBody`, `returnBtnA`, `activateDaoBtnA`, `returnBtnB`, `activateDaoBtnB`, `three-harmonies`, `countHeaven`, `countEarth`, `countHuman`, `barHeaven`, `barEarth`, `barHuman`, `harmonyMicrocopy`, `harmonyDetails`, `player-rank-badge`, `toasts`, `forgeSpinner`, `tutorialHistoryCloseBtn`, `paradoxIntroCloseBtn`, `chooseSimpleModeBtn`, `chooseSupportiveModeBtn`, `libraryList`, `librarySearchInput`, `libraryCloseBtn`, `optionsCloseBtn`, `exportSaveBtn`, `importSaveBtn`, `importSaveFileInput`, `optionsResetBtn`, `developerModeBtn`, `applyPlayModeBtn`, `playModeSelect`, `cancelReturn`, `confirmReturn`, `cancelActivateDao`, `confirmActivateDao`, `replaceActiveCloseBtn`, `t1ManifestAreaForge`, `higherTierManifestCdTextForge`, `higherTierManifestCdFillForge`, `higherTierManifestArea`, `mobileTabs`, `baguaHeader`, `flashLayer`, `particles`.
- Selector dependencies preserved: `.tutorial-focus`, `button[data-left-tab]`, `button[data-supportive-pick]`, `#inventory-panel .panel-body`, `#forge-panel .panel-body`, `button[data-vote-dao][data-vote-value]`, `#divergenceContinue`, `#mobileTabs button`.
- Class toggles preserved: `hidden`, `active`, `tutorial-finish-btn`, `done`, `current`, `tutorial-unlock-flash`, `panel-reveal`, `discovery-pulse`, `show`, `visible`, `resonance-locked`, `resonance-pill`, `res-neutral`, `res-resonance`, `res-discord`, `res-chaos`, `shake`, `mobile-hidden`.
- Dataset usage preserved: `data-left-tab`, `data-supportive-pick`, `data-card-id`, `data-filter`, `data-tab`, plus runtime `dataset.requireSelection`.

## Files changed

- Updated `index.html`
  - Added Google Fonts CDN link for `Ma Shan Zheng`, `Liu Jian Mao Cao`, `Noto Serif SC`, `Noto Serif`.
  - Added `<link rel="stylesheet" href="./xianxia.css">`.
  - Added GSAP and tsParticles CDN scripts in `<head>`.
  - Added `<div id="tsparticles"></div>`.
  - Wrapped existing app structure in:
    - `.scroll-wrapper`
    - `.scroll-rod.scroll-rod--top`
    - `.scroll-body`
    - `.scroll-rod.scroll-rod--bottom`
  - Added `<script src="./xianxia-animations.js"></script>` after the original game script.

- Added `xianxia.css`
  - Full visual overhaul for parchment/scroll UI, typography, tabs, cards, forge area, and button system.
  - Introduced required color palette variables on `:root`.
  - Added layered lacquer/parchment textures and global grain overlay.
  - Added scroll rod styling with ornamental knobs.
  - Added Dao card, active slot, and cultivator panel visual treatment with non-invasive selectors.
  - Added stricter pass for element-specific requirements:
    - Header restyled as rod gradient with non-button save indicator.
    - Left tab labels include secondary Chinese labels via pseudo-elements.
    - Tutorial panel, forge helper text, and feed/log area shifted to parchment + cinnabar/gold treatment.
    - Modal visuals converted to parchment style; forced removal of blur/glass effects.
    - Info panel adds centered seal watermark (`☯`) in a non-interactive layer.
    - Card metadata glyph treatment switched from dot-led look to symbolic UI.

- Added `xianxia-animations.js`
  - GSAP page entrance animation on `DOMContentLoaded`.
  - tsParticles ambient qi initialization targeting `#tsparticles`.
  - Non-invasive card draw animation hook via `MutationObserver` on `#inventoryGrid` (no edits to existing game logic).
