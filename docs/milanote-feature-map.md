# Milanote 3.18.141 vs milaclone — feature map & gap analysis

_Generated 2026-10-25 against milaclone `main` @ d125e8c._

## Method

- **Target:** `/Applications/Milanote.app` 3.18.141 (same build as `~/Downloads/Milanote-3.18.141.dmg`). It is an
  Electron app whose `Contents/Resources/app.asar` (sha256 `e3fa9b7b…bb9c`) bundles the whole web client.
- **REA static analysis** (`analyze_javascript_application`, evidence `ev_65671162…c9d6`): 536 JS sources,
  5,334 modules, 0 parse failures. Electron surface: 2 contextBridge APIs (8 members), 7 literal IPC channels.
  Route view `ev_2acfb256…`: account/settings pages only (`/settings`, `/interface`, `/toolbar`,
  `/preferences`…); the route set is marked partial. Nothing was executed.
- **Source maps:** the asar ships `build/*.js.map` with embedded `sourcesContent` covering 6,822 first-party
  files (`src/client/**`, `src/common/**`). The features below were read from those original sources, and each
  row cites its Milanote path. Rows are tagged **[S]** (read in source) or **[I]** (inferred).
- **milaclone:** every claim is checked against the code (file:line), not the README.
- **Scope:** single-user, self-hosted. Accounts, payments, sharing and collaboration are listed as out of scope.

## Milanote's model in one paragraph

17 element types: `CARD, DOCUMENT, LINK, IMAGE, FILE, TASK_LIST, TASK, COLUMN, BOARD, ALIAS` (board shortcut),
`CLONE` (synced copy), `LINE`, `SKETCH`, `ANNOTATION`, `COLOR_SWATCH`, `COMMENT_THREAD`, `TABLE`. Every element
lives on a grid-unit canvas with multi-selection, undo/redo, a restorable trash and system-clipboard paste.
Text uses a TipTap rich-text editor. Quick Notes is a per-user root **board** that collects any element
(`getCurrentUserQuickNotesRootBoardId`).

milaclone has 8 of these concepts: note≈CARD, todo≈TASK_LIST, link, image, file, comment, board, column.

## Bugs that lose data or are unsafe — fix these first

Each one was confirmed by reading the milaclone code.

1. **"Move to Trash" is a permanent, recursive delete.** Deleting a board wipes its whole sub-tree, with no
   confirmation, trash or undo (`menus.js:82`, `routes.js:202`, `db.js:119-137`). The Delete/Backspace key
   does the same (`main.js:46`).
2. **Cut → paste of a board or column destroys its contents.** Paste creates a fresh, empty child canvas
   (`clipboard.js:43-47` → `routes.js:106`), then deletes the original through `deleteItemDeep`. Columns lose
   their child cards the same way. Duplicate (cmd+D) produces an empty board or column.
3. **Edits are lost when two fields change quickly.** `saveData` debounces per item but sends only the
   *latest* patch (`editing.js:50-58`). For example, type a note title and then its body within 400 ms and the
   title never reaches the server. Pending saves are also dropped when the tab closes, and save failures are
   silent.
4. **Stored XSS through uploads.** `ALLOWED_UPLOAD` accepts `text/*` (HTML) and `image/svg+xml`
   (`routes.js:23`). These files are served by `express.static` from the app's own origin.
5. **Browser Back/Forward don't move between boards.** `openCanvas` uses `history.replaceState`
   (`main.js:31`).
6. **Phone and desktop overwrite each other's to-do lists.** `tasks` arrays are written whole, last write
   wins, so editing the same list in Quick notes and on the canvas overwrites one side.

## Ranked roadmap (biggest gap first)

| # | Gap | Area | Why it matters |
|---|---|---|---|
| 1 | Real trash + undo/redo (cmd+Z) | 4/5 | Combined with bug 1, one key press loses data |
| 2 | Deep copy for duplicate/paste; system-clipboard paste (images, URLs, text → elements); OS drag-and-drop of files and links | 4/2 | These are Milanote's main ways of capturing content |
| 3 | Rich-text editor (bold/italic, headings, lists, checklists, quotes, code, highlight, links, markdown shortcuts); a single body instead of title+body | 1 | The core of every note |
| 4 | Multi-select + marquee (pan with space/middle-drag as Milanote does); align/distribute, z-order, grid snap, arrow nudge | 4 | Needed to lay out a board |
| 5 | Lines/connectors between cards (arrowheads, styles, labels, curves) | 2 | A defining Milanote feature with no equivalent at all |
| 6 | Link unfurling (title/image/favicon) + video/music embeds | 1 | Links are hand-typed today |
| 7 | Global search (boards + card text) and cmd+F | 5/4 | Nothing outside Quick notes can be searched |
| 8 | Export: Markdown/plain-text linear export + ZIP of uploads (PNG/PDF later) | 4/5 | The Export button is a stub (`viewport.js:78`) |
| 9 | Image lightbox, caption, transparency; per-type file icons; audio/video files | 2 | Audio and video uploads are currently rejected |
| 10 | Task lists: nested indent, drag reorder, due date/assignee shown on canvas; collapsible columns with counts | 3 | Tasks are a flat list |
| 11 | Quick Notes semantics: an inbox *board* of any element, not a cross-board to-do aggregator (open PR #9 moves toward this) | 3 | Works differently from Milanote |
| 12 | Document element, colour swatch, sketch/annotation, table | 1/2 | Element types that are missing entirely |
| 13 | Dark mode, board background colours, Milanote palette (None + 11 colours), `/` shortcut modal, `z` zoom-to-fit, cmd+=/−/0, double-click to create a note | 4/5 | Polish and parity |
| 14 | Board shortcuts (alias), templates, labels/filtering, synced clones | 3 | Organisation features |

## Status counts per area (from the tables below)

| Area | Rows | Missing | Partial | Wrong | Done |
|---|---|---|---|---|---|
| 1 Text content | ~50 | 36 | 4 | 1 | 1 |
| 2 Media, lines, tables | ~58 | 39 | 5 | 1 | 4 |
| 3 Structure & organisation | ~52 | 16 | 9 | 7 | 6 |
| 4 Canvas & workspace (incl. 60+ shortcuts) | ~100 | most | see table | see table | few |
| 5 Platform | ~24 | 11 | 2 | 2 | — (8 out of scope) |

## What milaclone already does well

These have no Milanote counterpart or match it well: nested boards with icon/colour and a write-through
title; drag in/out of columns with an insertion point; position lock; per-board camera memory; pinch zoom;
cursor-anchored wheel zoom; mobile header/footer chrome; Docker/Tailscale deployment; self-contained
test suites.

## Unresolved / limits of this analysis

- Static only. No Milanote runtime was observed, so animations, server-side behaviour (e.g. link-unfurl
  service, search indexing) and feature flags/experiments are inferred from client code.
- The Milanote web clipper is a separate browser extension and isn't in the asar. The "harvester" bundle is
  New Relic telemetry.
- Paid/multi-user features (sharing, permissions, comments' @mentions, notifications, billing) are listed
  but not analysed in depth.

---

# Appendix — detailed area tables


## Area 1 — Text content elements (Card, Document, Link/rich media, Comments, Color swatch, rich-text editor)

Milanote paths are relative to the extracted sources (`src/...`). milaclone paths are relative to `/Users/ellingtonshephard/code_projects/milaclone`.
"Observed" = read in source. "Inferred" = deduced from file names / constants, not read in detail.

Baseline fact for milaclone: every text field is a plain `<textarea>`/`<input>` built by `makeField` (`public/js/cards.js:46-54`). There is no rich-text editor, no contenteditable on the canvas, and no `paste`/`drop` handler anywhere in `public/js/` (grep: none). Item types: note, todo, link, image, file, comment, board, column (`public/js/cards.js:70-77`).

## Card (rich-text note)

| Feature | Milanote behaviour | Milanote evidence (path) | milaclone status | milaclone ref | Notes |
|---|---|---|---|---|---|
| Text card element | Single rich-text body (Tiptap); first line typically a heading, no separate title field | `src/client/element/card/CardEditor.tsx`, `card/tiptap/CardTiptapEditor.tsx` (observed) | Wrong | `public/js/cards.js:123-132` | milaclone note = separate Title textarea + plain Body textarea. Works, but structure differs from Milanote's single-body card. |
| Card colour | Colour fills/tints the card | `src/client/element/card/Card.jsx` (inferred) | Partial | `public/js/cards.js:125`, `public/style.css:157` | milaclone only draws a 4px left accent bar. |
| Card resize width | Drag to resize | element resize decorators (inferred) | Done | `public/js/cards.js:112-116` | |
| Mod+Enter creates new card below | Shortcut in card editor creates next card | `src/client/element/card/tiptap/useCardTiptapEditorExtensions.ts` (`Mod-Enter`, observed) | Missing | — | |
| Universal card auto-conversion | Typing only a URL converts the card to a Link; only a colour code converts to a Colour swatch; `[] ` converts to a task list | `src/common/tiptap/extensions/universalCard/{UniversalCard,link,swatch,task}.ts` (observed) | Missing | — | |
| Card clipper | Select text inside a card and drag/clip it out into a new card | `src/client/element/card/clipper/*` (inferred from names + `cardClipperUtils.ts`) | Missing | — | |
| Suggest converting long card to Document | When a card grows past ~A4 height, suggests turning it into a Document | `src/client/element/card/suggestDocumentDecorator.jsx` (observed) | Missing | — | Depends on Document element. |
| Search highlight inside text | Board search highlights matches in card text | `src/common/tiptap/extensions/SearchHighlighter.ts` (inferred) | Missing | — | Search itself belongs to another area. |

## Rich-text editor (src/common/tiptap)

Card editor extension set observed in `src/client/element/card/tiptap/useCardTiptapEditorExtensions.ts` and `src/common/tiptap/extensions/extensionLists.ts`. milaclone has none of these on canvas cards; the only formatting anywhere is Quick-notes' whole-note B/I/U toggle + line-prefix bullets/numbers (`public/js/quicknotes.js:585-597`), which is not per-selection rich text.

| Feature | Milanote behaviour | Milanote evidence (path) | milaclone status | milaclone ref | Notes |
|---|---|---|---|---|---|
| Bold / italic / underline | Marks, Mod-B/I/U | `extensionLists.ts` (StarterKit + Underline, observed) | Missing (canvas) / Partial (Quick notes) | `public/js/quicknotes.js:576-578, 591` | Quick notes styles the entire note, not a selection. |
| Strikethrough | Mark, Mod-Shift-X, `~text~` input rule | `extensions/Strike.ts` (observed) | Missing | — | |
| Headings | H1, H2 only; Mod-Shift-1/2; `# ` / `## ` markdown | `extensions/Heading.ts` (observed) | Missing | — | |
| Small text | Block type, Mod-Shift-9 | `extensions/SmallText.ts` (observed) | Missing | — | |
| Bullet / numbered lists | Nested lists, `- ` / `1. ` shortcuts, Tab/Shift-Tab indent, list keymap | `extensions/list/*`, `textIndentation/*` (observed) | Missing (canvas) / Partial (Quick notes) | `public/js/quicknotes.js:588-589` | Quick notes only prefixes lines with text. |
| Inline checklist in card | Legacy task list/task items inside a card body | `extensions/LegacyTaskList.ts`, `LegacyTaskItem.tsx` (observed in list) | Partial | `public/js/cards.js:146-178` | milaclone has a separate To-do card type instead; cannot mix checklist with text. (Task lists are another area.) |
| Blockquote | `> `, Mod-Shift-B / Mod-' | `extensions/Blockquote.ts` (observed) | Missing | — | |
| Code block / inline code | Code block Mod-. ; inline code mark (formatting allowed inside) | `extensions/CodeBlock.ts`, `CodeMark.ts` (observed) | Missing | — | |
| Callout | Emoji-iconed callout block; `!tip `, `!warning ` etc. input rule; maps to GitHub alerts | `extensions/Callout.ts` (observed) | Missing | — | |
| Horizontal rule | `---`, `***`, `___` | `extensions/HorizontalRule.ts` (observed) | Missing | — | |
| Highlight | Multicolour highlight; Mod-J / Mod-Shift-H; `==text==` | `extensions/TextHighlight.ts` (observed) | Missing | — | |
| Text colour | Limited palette: blue, green, orange, red, grey | `extensions/TextColor.ts` (observed) | Missing | — | |
| Text alignment | Centre alignment for paragraphs/headings | `extensions/TextAlign.ts` (observed) | Missing | — | |
| Uppercase selection | Shift-F3 | `extensions/TextCase.ts` (observed) | Missing | — | Minor. |
| Hyperlinks in text | Mod-K link popup, `[text](url)` input rule, autolinking of typed URLs, emails, click-to-open | `extensions/hyperlink/{Link,decorationAutolink,isLinkAnEmail,linkClickHandler}.ts` (observed) | Missing | — | URLs in note bodies are inert text. |
| Inline board links | Pasting a board URL renders as an inline board chip with title | `extensions/inlineBoardLink/*` (observed) | Missing | — | |
| Inline colour swatches | Hex/RGB codes in text get a coloured dot decoration | `extensions/inlineSwatch/InlineSwatch.ts` (observed) | Missing | — | |
| Rich paste | Paste HTML / tables / tasks into rich structure | `extensions/PasteTransformer.ts`, `TablePaste.ts`, `LegacyTaskPaste.ts` (inferred) | Missing | — | Plain-text paste into textarea only. |
| Clear inline style on Enter / exit quote on empty Enter | Editing ergonomics | `extensions/InlineStyleClearer.ts`, `WrappingBlockClearer.ts` (observed comments) | N/A | — | Only meaningful once rich text exists. |

## Document

| Feature | Milanote behaviour | Milanote evidence (path) | milaclone status | milaclone ref | Notes |
|---|---|---|---|---|---|
| Document element | Icon-style tile on the board with editable title; opens into a full-screen modal long-form editor (mobile: sheet) | `src/client/element/document/documentViews/DocumentIconView.jsx`, `modal/DocumentModal.tsx`, `modal/MobileDocumentSheet.tsx` (observed/inferred) | Missing | — | |
| Formatting sidebar | Modal has a full text-editing toolbar (inline + block tools) | `modal/DocumentModalSidebar.tsx` (observed) | Missing | — | |
| Word count | Live word count | `documentViews/WordCount.jsx` (observed) | Missing | — | |
| Export document | Export popup from modal header | `modal/DocumentModalHeader.jsx` (observed) | Missing | — | Export formats likely in another area. |
| Convert card(s) to document | Uses the card's first line (≤60 chars) as title | `document/documentActions.ts` (observed) | Missing | — | |

## Link + rich media

| Feature | Milanote behaviour | Milanote evidence (path) | milaclone status | milaclone ref | Notes |
|---|---|---|---|---|---|
| Link element basic | URL card with title, click to open | `src/client/element/link/{Link.jsx,LinkMetadata.jsx,LinkAnchor.jsx}` (observed) | Partial | `public/js/cards.js:180-191`, `public/js/util.js:24` | User must type title and URL manually; "Open ↗" link. |
| URL unfurling | On paste/entry, fetches page title, description, preview image, favicon; spinner while fetching, fail icon on error | `link/linkActions.ts`, `LinkStateDisplay.tsx` (observed), `link/richMedia/LinkImage.jsx` (inferred) | Missing | — | No server metadata fetch route in `routes.js`. |
| Show/hide preview media, caption | Toggle media visibility; optional caption; resizable meta section | `Link.jsx` (`getShowMedia`, caption, observed), `ResizableLinkMetaSection` (inferred) | Missing | — | |
| Link type icons | Video / audio / map default icons | `LinkStateDisplay.tsx` (observed), `common/links/linkConstants.ts` | Missing | — | |
| Rich media embeds | Playable embeds; known providers include YouTube, Vimeo, SoundCloud, Spotify, Loom, Wistia, Figma, Google Maps/Docs, CodePen, Twitter, etc.; media types IMAGE/VIDEO/AUDIO/RICH/MAP/PDF with resize and fixed aspect ratio for video | `src/common/links/{linkConstants,detectProviderFromUrl,richMediaConstants}.ts`, `src/client/element/richMedia/components/*` (observed) | Missing | — | |
| Typed/pasted URL becomes link | Card text that is only a URL converts to Link | `universalCard/link.ts` (observed) | Missing | — | Also no canvas paste handler. |

## Comments, mentions, reactions

| Feature | Milanote behaviour | Milanote evidence (path) | milaclone status | milaclone ref | Notes |
|---|---|---|---|---|---|
| Comment thread element | Thread of multiple comments (add/edit/delete each), rich-text comment editor with Post button, collapsed bubble vs expanded thread | `src/client/element/comment/{CommentThread,CommentForm,CommentThreadExpanded}.jsx`, `collapsed/*`, `commentEditor/*`, `common/comments/commentConstants.ts` (observed) | Partial | `public/js/cards.js:134-144` | milaclone comment is one free-text body with an icon — a note with a different look. No multiple entries, timestamps, collapse. |
| Comment timestamps / activity | Per-comment author + time | `comment/CommentLine.jsx`, `CommentActivity.jsx` (inferred) | Missing | — | Timestamps still useful single-user. |
| Attached comments | Comment threads attached to an element, and inline comments anchored to a text range | `src/client/element/attachedComment/*`, `common/tiptap/extensions/inlineComment/*`, `common/comments/attachedCommentUtil.ts` (observed) | Missing | — | |
| Reactions | Emoji reaction pills on elements/comments | `src/client/element/reactions/*` (observed `reactionUtil.js`) | Missing | — | Mostly multi-user value. |
| Mentions | @user suggestions in text | `src/client/element/mentions/*`, `tiptap/extensions/mention/*` (inferred) | Out of scope | — | Multi-user. |

## Colour swatch

| Feature | Milanote behaviour | Milanote evidence (path) | milaclone status | milaclone ref | Notes |
|---|---|---|---|---|---|
| Colour swatch element | Block of colour with editable caption, shows colour value and name; resizable; colour picker on edit; created by typing a hex/rgb code in a card | `src/client/element/colorSwatch/{ColorSwatch.jsx,ColorSwatchPicker.tsx}`, `universalCard/swatch.ts` (`showColorValue`, `getColorName`, observed) | Missing | — | milaclone only has a fixed card-colour palette (`public/js/menus.js:13-59`). |

## Out of scope (multi-user/paid/account)
Mentions, typing-activity pings, remote-activity indicators, reaction user lists, comment author identity, live-collaboration editor behaviour.

## Top gaps (ranked for a single-user self-hosted clone)
1. **No rich-text editor on cards**: no bold/italic, headings, lists, links, quotes, code, highlight, or markdown shortcuts. Every other text feature depends on this (`cards.js:46-54, 123-132`).
2. **No link unfurling or rich-media embeds**: links need a manual title, with no preview image, favicon, or playable YouTube/Vimeo/Spotify embed (`cards.js:180-191`; no metadata route in `routes.js`).
3. **No Document element**: no long-form, full-screen editor with word count.
4. **No smart creation by paste or typing**: pasting a URL or image onto the canvas, or typing a URL or hex code into a card, does not create a link or swatch (no paste handler in `public/js/`).
5. **Comments are a single note, not a thread**: no multiple timestamped entries, no attaching to an element, no inline comments (`cards.js:134-144`).
6. **No colour swatch element**.


## Area 2 — Media, lines/connections, sketches/annotations, tables, resizing

Milanote paths are relative to the extracted sources (`src/...`). milaclone refs are relative to the repo root.
"Obs" = observed in source; "Inf" = inferred from file/identifier names without reading full logic.

| Feature | Milanote behaviour | Milanote evidence (path) | milaclone status | milaclone ref | Notes |
|---|---|---|---|---|---|
| **IMAGE** | | | | | |
| Add image via file picker | Image tool opens uploader; uploads into an image element | `src/client/element/image/ImageUploader.jsx` (Inf) | Done | `public/js/tools.js:41,56-71`; `public/index.html:59,255` | Arm tool, click canvas, pick file. |
| Add image by drag-drop from desktop / paste from clipboard | Images dropped/pasted onto canvas or onto an existing image (replace) | `src/client/element/image/imageDropTargetDecorator.js`, `imageHoverDropDecorator.jsx`, `ImageReplacementOverlay.jsx` (Inf) | Missing | — (no `drop`/`clipboardData` handlers anywhere in `public/js`) | Paste in milaclone is internal card clipboard only (`public/js/clipboard.js:35`). |
| Image web search (stock photos) | Toolbar image popup searches a stock provider (Pexels attribution) with "load more" | `src/client/workspace/toolbar/components/elementTools/imageTool/popup/ImageSearchPopup.jsx`; `src/common/images/imageConstants.ts` (`PEXELS_ATTRIBUTION_LINK`) (Obs) | Missing | — | Needs an API key; low value self-hosted. |
| Image from URL (linked/proxied image) | Linked images fetched through a safe media proxy | `src/common/images/imageConstants.ts` (`LINKED_IMAGE_URL_PREFIX`) (Obs) | Missing | — | |
| Natural aspect ratio display | Image keeps its aspect ratio | `src/client/element/resizing/resizeTypes.ts` (`ResizeAspectLock.MEDIA`) (Obs) | Done | `public/js/cards.js:193-197`; `public/js/tools.js:61-67` (stores naturalW/H) | `aspect-ratio` is applied to the padded card and the `<img>` uses `object-fit: cover` (`public/style.css:183-184`), so a few px of edge get cropped — minor. |
| Multi-resolution thumbnails | Server produces thumb/regular/large/huge/original sizes; canvas loads the appropriate one | `src/common/images/imageConstants.ts` (`IMAGE_SIZES`) (Obs) | Missing | `routes.js:230-236` stores original only | Matters for boards with many large photos (perf). |
| Caption | Toggleable rich-text caption under an image, with placeholder | `src/client/element/image/Image.jsx` (`captionVisible`, `captionPlaceholder`); `.../selectionTools/captionTool/CaptionTool.jsx` (Obs) | Missing | — | |
| Transparent display (no card background) | Toggle to show PNGs without the white card/background | `src/client/element/image/Image.jsx` (`transparent`, `ShowBackground`); `.../selectionTools/imageBackgroundTool/ImageBackgroundTool.tsx` (Obs) | Missing | `public/style.css:183` (always padded card) | |
| Crop | Image editor modal has crop mode (and crop-to-grid on canvas) | `src/client/element/image/modal/content/ImageModalCropModeContent.jsx`, `modal/v2/content/ImageModalV2CropModeContent.tsx`; `Image.jsx` (`cropInset`, `cropToGrid`) (Obs) | Missing | — | |
| Rotate | Image editor rotate | `src/client/element/image/modal/content/hooks/useImageRotation.ts` (Inf) | Missing | — | |
| Background removal | AI background removal in image editor | `src/client/element/image/modal/backgroundRemoval/*`, `modal/v2/content/ImageModalV2BackgroundModeContent.tsx` (Inf) | Missing | — | Cloud feature; skip. |
| Lightbox / full-screen view | Double-click opens image modal: zoom/pan, prev/next across board images, download, share | `src/client/element/image/modal/ImageModal.jsx`, `ImageModalNavigation.jsx`, `hooks/useImageModalZoom.ts`, `useOrderedImageElements.js`, `modalToolbar/ModalToolbarDownloadButton.tsx` (Obs names) | Missing | — (no dblclick on images; `public/js/cards.js:244` is boards only) | Highest-value image gap. |
| Draw on image | Drawing mode inside image modal; strokes stored with the image and rendered over it | `src/client/element/image/modal/content/ImageModalDrawingModeContent.jsx`, `image/ImageDrawing.jsx`, `imageDrawingUtils.js` (Inf) | Missing | — | |
| Animated GIF / autoplay | Media tools for autoplay/loop | `.../selectionTools/attachmentTool/MediaAutoplayTool.jsx`, `MediaLoopTool.jsx` (Inf) | Partial | `public/js/cards.js:195` | GIFs animate natively via `<img>`; no controls. |
| **FILE** | | | | | |
| Upload file | Upload any file; per-type size limits (free/pro) | `src/common/files/fileTypes.ts` (`maxSize`), `file/uploader/FileUploader.jsx` (Obs) | Partial | `public/js/tools.js:42,73-87`; `routes.js:23-34,47`; `public/index.html:256` | Mime allow-list excludes audio, video, fonts, design files; 25 MB cap. Drag-drop upload missing. |
| Per-type file icons | ~35 file types (PDF, audio, video, zip, code, Office, Apple iWork, Adobe, Sketch, fonts, 3D…) each with its own icon | `src/common/files/fileTypes.ts` (`FileTypes` enum, `iconName`); `src/client/components/fileIcon/icons/*` (Obs) | Wrong | `public/js/cards.js:200-204` | Every file shows the same `file-text` icon regardless of type. |
| File preview image on card | Card shows a rendered preview (e.g. PDF first page, image) when available; user can toggle preview vs icon ("Card view") | `src/client/element/file/FilePreviewImage.jsx`, `utils/fileIsShowingFilePreview.js` (`showMedia`), `fileIconView/FileIconView.jsx` (Obs) | Missing | — | Server-side rendering needed for PDF thumbnails. |
| File detail (name, size, type) | Secondary details row (size, extension) | `src/client/element/file/fileDetailView/FileSecondaryDetails.jsx`; `src/common/files/fileSizeUtils.js` (Inf) | Partial | `public/js/cards.js:205-207` | Name only; size not stored (`routes.js:232-236`). |
| Open / download | Download button; open in modal | `src/client/element/attachments/attachmentDownloadActions.js` (Inf) | Done | `public/js/cards.js:208-210` | "Open ↗" link with `download` attr. |
| PDF / text in-app viewer | PDF and text files open in an in-app modal iframe (native viewer) | `src/client/element/file/utils/fileSupportsModalView.js`, `modal/FileModalIFrameView.jsx` (Obs) | Partial | `public/js/cards.js:208-210` | Opens in a new browser tab instead of a modal; functionally close. |
| Audio / video playback | Inline media player on the card: play, scrubber, duration, volume; autoplay/loop toggles; iPhone video modal | `src/client/element/file/mediaPlayer/FileMediaPlayer*.jsx`, `utils/fileGetMediaPlayerType.js` (Obs) | Missing | `routes.js:23-34` rejects `audio/*` and `video/*` | Even upload is blocked. Native `<audio>/<video controls>` would cover most of it. |
| **SKETCH** | | | | | |
| Sketch element | Card containing a freehand drawing; opens a sketch modal to edit | `src/client/element/drawing/sketch/Sketch.jsx`, `modal/SketchModal.jsx`; `src/common/drawings/sketches/sketchConstants.ts` (Obs) | Missing | — | |
| Pen tool / stroke sizes | Pressure-ish freehand strokes (perfect-freehand smoothing), 4 sizes (S/M/L/XL) | `drawing/drawingEditor/drawingEditorConstants.js` (`STROKE_SIZES`), `drawingDefaults.ts`, `perfectFreehandUtils.ts` (Obs) | Missing | — | |
| Colors | Stroke color picker | `drawingEditorToolbar/DrawingEditorColorToolV2.tsx` (Obs name) | Missing | — | |
| Eraser / select / move strokes | Tool modes draw, move, select (marquee), erase | `drawingEditorConstants.js` (`TOOL_MODES`), `drawingEditorCanvas/DrawingEditorCanvasEraseMode.jsx`, `selectMode/*` (Obs) | Missing | — | |
| Undo/redo inside editor; Apple Pencil double-tap | Per-editor undo/redo; iPad pen tools | `drawingEditorToolbar/DrawingEditorToolbarUndoRedoTools.jsx`, `usePencilDoubleTap.js` (Inf) | Missing | — | |
| **ANNOTATION** | | | | | |
| Freehand drawing directly on the canvas | Draw tool creates an Annotation element whose bounds snap out to the grid around the strokes; edited in place (no modal) | `src/client/element/drawing/annotation/Annotation.jsx`, `annotationEditor/AnnotationEditor.jsx`, `annotationEditorUtils.ts` (grid-aligned bounding rect) (Obs) | Missing | — | |
| **LINE / CONNECTIONS** | | | | | |
| Line element | Free-standing line/arrow on the canvas | `src/client/element/line/Line.jsx`; `src/common/lines/lineConstants.ts` (Obs) | Missing | — | No SVG overlay layer exists in milaclone. |
| Connect to cards (snapping) | Line ends snap to elements and stay attached when cards move | `line/elementLineEdgeDropTarget.jsx`, `connections/elementConnectionsUtils.js` (start/end connected element ids) (Obs) | Missing | — | Core Milanote mind-map/flow capability. |
| Quick line | Drag a handle on a selected card (canvas or in column) to spawn a connected line | `src/client/element/quickLine/QuickLineCreationTool.jsx`, `quickLineUtil.js` (Obs) | Missing | — | |
| Curves | Drag the midpoint control point to bend the line (quadratic Bézier) | `line/svg/LinePath.jsx` (quadratic path), `line/ControlPointDragHandle.jsx` (Obs) | Missing | — | |
| Line style | Solid / dashed / dotted | `src/common/lines/lineConstants.ts` (`LINE_STYLE`), `.../lineTools/LineStyleTool.jsx` (Obs) | Missing | — | |
| Arrowheads | Each end: arrow, dot, or none | `lineConstants.ts` (`LINE_MARKER_STYLE`), `line/svg/ArrowMarker.jsx` (Obs) | Missing | — | |
| Weight | S / M / L (1/2/4) | `lineConstants.ts` (`LINE_WEIGHT`), `.../lineTools/LineWeightTool.jsx` (Obs) | Missing | — | |
| Label | Editable text label on the line | `line/label/LineLabel.jsx`, `.../lineTools/LineLabelTool.jsx` (Obs) | Missing | — | |
| Color | Line takes the standard color palette | `.../selectionTools/colorTools/*` (Inf: shared color tool applies to lines) | Missing | — | |
| Angle snapping | Line endpoints snap to angle increments while dragging | `line/utils/lineSnapAngleUtil.js` (Inf) | Missing | — | |
| **TABLE** | | | | | |
| Table element | Grid (default 3 cols x 4 rows) with optional title; Handsontable-based | `src/common/table/tableConstants.ts`, `src/client/element/table/module/HotTable.tsx`, `TableTitleEditor.tsx` (Obs) | Missing | — | |
| Rows/cols: add, remove, move, resize columns | Context menu insert above/below/left/right, remove, move; manual column resize | `table/module/handlers/contextMenu/tableContextMenuConfig.ts`, `module/hotPluginsRegistration.ts` (ManualColumnResize/Move, ManualRowMove) (Obs) | Missing | — | |
| Cell types & formatting | Auto, Number, Currency, Percentage, Text, Date/Time, Checkbox; decimals, thousands separators, currency display, date/time formats | `src/common/table/CellTypeConstants.ts` (Obs) | Missing | — | |
| Formulas | Spreadsheet formulas (HyperFormula) with autocomplete and click-to-reference cells | `module/manager/hyperFormulaInstance.ts`, `plugins/FormulaAutocompleteHotPlugin.ts`, `FormulaCellReferenceHotPlugin/*` (Obs) | Missing | — | |
| Cell styling | Cell background color, text alignment (h/v), rich text style | `module/tools/TableCellColorTool.tsx`, `TableCellAlignmentTool.tsx`, `TableTextStyleTool.tsx`; `CellTypeConstants.ts` (`TextAlignment`, `VerticalAlignment`) (Obs) | Missing | — | |
| Paste from spreadsheet / HTML table; autofill | Copy-paste extension handles HTML tables; drag-fill | `bridge/utils/dataUtils/clipboard/tableClipboardUtils.ts`, `plugins/CopyPasteExtensionHotPlugin.ts`, `AutofillExtensionHotPlugin.ts` (Obs) | Missing | — | |
| Sorting | Not present: no ColumnSorting plugin registered | `module/hotPluginsRegistration.ts` (Obs, by absence) | n/a | — | Not a Milanote feature; don't build. |
| **RESIZING** | | | | | |
| Resize handle on cards | Resize handle per element; aspect-lock rules per type (always / optional with modifier / never) | `src/client/element/resizing/ElementResizeHandle.tsx`, `resizeTypes.ts` (`MaintainAspectRatioMode`, `ResizeAspectLock`) (Obs) | Partial | `public/js/cards.js:112-116`; `public/js/drag.js:122-139` | Width-only, clamped 120–900px, no grid snap; height always auto. Images keep ratio via CSS. |
| Media-only display when shrunk | Shrinking a file/media card below a threshold hides meta and shows media only (also a toolbar preference) | `resizeTypes.ts` (`MediaOnlyDisplay`); `file/fileElementConstants.js` (`FILE_ELEMENT_FULL_DISPLAY_MIN_WIDTH`) (Obs) | Missing | — | |
| Double-click handle to reset size | Double-click resize handle toggles between default width and media's natural width | `resizing/elementDoubleClickResizeDecorator.tsx`, `image/imageDoubleClickResizeDecorator.tsx` (Obs comments) | Missing | — | |
| Group resize | Resize multiple selected elements together | `resizing/useGroupResizeBehaviour.ts`, `groupResizeStateDecorator.tsx` (Inf) | Missing | — | milaclone has single selection only. |
| Height resize for notes (scrollable editor) | Text cards can be given a fixed height with overflow indicator | `resizing/resizableEditor/*` (Inf) | Missing | — | |
| Resize inside columns | Column children are not individually resizable | (Inf) | Done | `public/js/cards.js:112`; `public/style.css:204` | Matches. |

## Top gaps (ranked for a single-user self-hosted clone)

1. **Lines / connections (with snapping, arrowheads, quick-line)** — the biggest missing Milanote primitive; no SVG layer exists. Start with: straight connected line, arrow/none ends, dashed style, color; curves and labels next.
2. **Image lightbox** — double-click to view full-size with zoom and prev/next across board images. Cheap, used constantly.
3. **Drag-drop and paste of images/files onto the canvas** — today only the picker works; the main way Milanote users add media.
4. **File cards: per-type icons + audio/video playback** — unblock `audio/*`/`video/*` in `routes.js:23-34` and render native `<audio>/<video controls>`; map extension to a lucide icon; store file size.
5. **Image caption + transparent background toggle** — small data fields, high visual parity.
6. **Sketch / annotation (freehand drawing)** — pen, 4 sizes, colors, eraser; SVG paths stored in `item.data`. Tables (with formulas/cell types) are a larger build and rank below this unless the user actually uses Milanote tables.


## 3. Structure & organisation — Milanote vs milaclone

Legend: **Obs** = read in source, **Inf** = inferred (not directly confirmed). Milanote paths are under the extracted `src/`; milaclone paths are relative to the repo root. "N/A" = collaboration-only or not user-visible, so it doesn't matter for a single-user clone.

| Feature | Milanote behaviour | Milanote evidence (path) | milaclone status | milaclone ref | Notes |
|---|---|---|---|---|---|
| **TASK LIST / TASK** | | | | | |
| Tick a task done | A per-task `isComplete` flag that toggles when you click the checkbox. | client/element/task/taskActions.js (setTaskCompletion) | Done | public/js/cards.js:158-159 | Obs. |
| Enter adds a task, Backspace on an empty task deletes it | Handled by the task editor's keyboard shortcuts. | client/element/task/editor/useTaskTiptapEditorKeyboardShortcutsExtension.ts | Done | public/js/cards.js:163-164 | Obs. |
| Nesting / indent | Tasks can be indented up to `MAX_TASK_DEPTH = 6`. Each level shifts by a fixed amount. | client/element/taskList/taskListActions.js; client/element/task/TaskDepthIndent.jsx | Missing | — | Obs. milaclone's tasks are a flat array (`{id,text,done}`). |
| Drag tasks to reorder | Each task has a drag handle, plus drop-geometry utilities for working out where it lands. | client/element/task/TaskDragHandle.jsx; client/element/taskList/editor/taskListDropGeometryUtils.ts | Missing | public/js/cards.js:154-171 (no handle) | Obs. Quick notes has no reorder either. |
| Drag a task out of its list | Dropping a task on the canvas or into a column creates a new to-do list containing that task. One undo reverses it. | client/element/taskList/editor/taskListDragOutUtils.ts | Missing | — | Obs. |
| Optional list title | `showTitle` defaults to false, so a new list has no header. A "suggest title" step adds one later. | common/taskLists/taskListConstants.ts; common/taskLists/index.js; client/element/taskList/suggestTitleDecorator.jsx | Wrong | public/js/create.js:14; public/js/cards.js:148 | Obs. milaclone always shows a title field, defaulting to "To-do". |
| "Delete completed tasks" suggestion | Offered once 2 or more tasks are complete, and can be dismissed for good. | client/element/taskList/suggestion/singleEditor/taskListSuggestionTriggerUtils.ts; common/taskLists/taskListConstants.ts | Missing | — | Obs. |
| Due date | A due-date chip on the task. Supports an optional time and reminders (none, when due, 10 min before, 1 h before, 9am on the day, 9am the day before). The chip shows on the canvas card. | client/element/task/pills/assignment/dueDate/*; client/element/chipsPanel/chips/DueDateChip.tsx | Partial | public/js/quicknotes.js:518-549 (date only); public/js/cards.js:146-178 (nothing shown) | Obs. You can only set a date-only `due` in Quick notes. There is no time and no reminder, and the canvas card never shows it. |
| Assignees | Assignment chip and member picker. | client/element/task/pills/assignment/TaskAssignmentPopup*.jsx; chipsPanel/chips/AssignmentChipView.tsx | N/A (Missing) | — | Obs. Needs multiple users. |
| Labels on tasks | Coloured, global labels are attached to task items and shown as pills. | client/element/task/pills/labels/TaskLabelPills.tsx; common/taskLists/taskListLabelUtils.ts | Partial | public/js/quicknotes.js:763-796 (tags) | Obs. milaclone tags are free-text, lowercase, with no colour, and only visible in Quick notes. Inf: Milanote labels can be renamed and recoloured centrally (`labelsService` endpoints). |
| Reactions on tasks | Reaction chip/pill. | client/element/chipsPanel/chips/ReactionChip.tsx | N/A | — | Obs. Collaboration feature. |
| Progress display | No progress or count UI found on the canvas to-do element (no "progress" identifier in taskList/task sources). | client/element/taskList/* (absence) | Done+ (extra) | public/js/quicknotes.js:450-452 ("done of all") | Inf from absence. milaclone shows the count only in Quick notes. |
| Copy/paste tasks as rich text or HTML | Clipboard copy and paste utilities for task lists. | common/taskLists/taskListClipboard{Copy,Html,Paste}Utils.ts | Missing | — | Obs. milaclone's copy/paste works on whole cards only. |
| **COLUMN** | | | | | |
| Put cards into and out of a column, and reorder them | Columns are list drop targets with a bottom drop area. | client/element/column/Column.jsx; ColumnBottomDropArea.jsx | Done | public/js/drag.js:72-111 | Obs. |
| What a column can hold | Anything except lines, annotations and other columns (so boards are allowed). | common/columns/columnUtils.ts (canBeAColumnChild) | Done | public/js/drag.js:84 | Obs. milaclone blocks only columns; it has no line or annotation types. |
| Collapse / expand | A `collapsed` flag toggled by a button. A collapsed column hides its list but still shows the child count and an activity dot. It auto-expands when the search filter matches a child. | client/element/column/ColumnCollapseButton.jsx; Column.jsx; ColumnCollapsedActivityIndicator.jsx | Missing | — | Obs. |
| Column colour | A colour bar plus a background tint for the whole column (`COLUMN_COLORS`). | client/element/column/Column.jsx | Partial | public/js/cards.js:266 | Obs. milaclone colours only a small chip in the header. |
| Child count tag | "N cards, M boards" shown under the column. | client/element/column/Column.jsx → containerElement/ContainerElementChildCount.jsx | Missing | — | Obs. |
| Make a column from the selection | Creates a column and moves the selected elements into it (Cmd+drop). | client/element/column/columnActions.js (createColumnWithChildren) | Missing | — | Obs. |
| Convert column to board | Turns a column into a board, and its children go to the new board's inbox. | client/element/column/columnActions.js (convertColumnToBoard) | Missing | — | Obs. |
| Column sorting | None found. | client/element/column/* (absence) | N/A | — | Inf. |
| Default title | "New Column". | common/columns/columnConstants.ts | Wrong (minor) | public/js/create.js:16 ("Column") | Obs. Cosmetic only. |
| **BOARD** | | | | | |
| Nested boards and navigation | A board element owns child elements. A breadcrumb hierarchy is maintained. | client/element/board/hierarchy/*; common/boards/* | Done | routes.js:85-121; public/js/cards.js:31-44, 238-261 | Obs. |
| Board colour | Picked by the user. When the board is created, it is auto-chosen from a colour word in the title, then the title's sentiment (positive→green, negative→red), then the board's suggested palette. | client/element/board/boardActions.js (getColor) | Partial | public/js/menus.js:20-25; routes.js:144-148 | Obs. Manual colour works. milaclone has no title-based auto-colour; it defaults to slate. |
| Board icon | Auto-picked by searching the icon library for the title and avoiding icons sibling boards already use. Falls back to a letter or number. The user can search all icons. | client/element/board/boardActions.js (getBoardDecoration, pickUnusedIcon, makeFallbackBoardIcon) | Partial | routes.js:16-21, 99; public/js/menus.js:28-48 | Obs. milaclone picks one of 24 Lucide icons at random, with no search and no match to the title. |
| Image as board icon | A board can show an uploaded image instead of a glyph. | client/element/board/boardIcon/BoardImage.jsx | Missing | — | Obs. |
| Card count under board | Counts by type, e.g. "3 boards, 5 cards, 1 file, 2 docs". Shows "0 cards" when empty and "Duplicating…" while a copy is in progress. | client/element/containerElement/containerElementUtil.ts; board/BoardEmptyContentsTag.jsx | Partial | routes.js:60-62; db.js:46; public/js/cards.js:231 | Obs. milaclone shows a single "N cards" count of top-level items: boards and columns count as cards, and cards inside columns are not counted. |
| Default title | "New Board". | common/boards/boardConstants.ts | Wrong (minor) | public/js/create.js:17 ("Untitled board") | Obs. |
| Shared/published status badges | Icons on the board tile. | client/element/board/boardIcon/BoardStatus.jsx | N/A | — | Obs. |
| Board inbox section | Each board has an INBOX section (used when converting a column or receiving items). | common/boards/boardConstants.ts (BoardSections, InboxState) | Missing | — | Obs. Low priority. |
| Board preview workspace | A read-only render of a board, driven by query params (hide background or inbox, centre the canvas). Used for publish and preview. | client/workspace/boardPreview/* | N/A | — | Obs. Not interactive for the user. |
| **ALIAS (board shortcut)** | Links to a board that lives elsewhere. Shows the original's title, colour, icon and image, plus a shortcut badge. Its menu has "find original", which navigates to the parent board and highlights the original (shows a toast if it can't be reached). | client/element/alias/*; common/alias/aliasUtils.js; board/boardIcon/BoardShortcutIcon.jsx | Missing | — | Obs. milaclone can only paste a new empty board. |
| **CLONE** | A live linked copy of any element. Content edits on a clone are redirected to the original, while size and position stay per clone. A popup lists every instance across boards. | client/element/clone/cloneActionMiddleware.js; cloneUtils.js; cloneInstances/* | Missing | — | Obs. |
| **DUPLICATE** | Duplicates elements deeply. A duplicated board copies its whole subtree, showing "Duplicating…" while it processes. | client/element/duplicate/elementDuplicateActions.js; containerElementUtil.ts | Wrong | public/js/clipboard.js:13-24, 43-47, 69-75 | Obs. In milaclone, Cmd+D or paste on a board creates a new **empty** board named "<title> copy". Duplicating a column copies none of its cards. |
| **TRASH & restore** | Deleted elements go to a per-board trash (`<boardId>-trash`, `BoardSections.TRASH`). They can be restored or the trash cleared, with trash tabs for personal vs others. The deletions made this session are tracked. | common/boards/boardConstants.ts; common/elements/trash/trashConstants.js; client/element/deletedElements/* | Wrong | public/js/menus.js:82 ("Move to Trash"); routes.js:206-209; db.js:113-136 | Obs. The label says Trash, but milaclone **permanently** deletes the item, including whole board subtrees, with no confirmation and no undo. |
| **LABELS / filter** | | | | | |
| Labels on any element | Global labels with colours from `LABEL_COLORS`, added to or removed from many elements at once. You can look up where a label is used. | client/element/labels/elementLabelActions.ts; labelsService.ts; labelUtils.ts; pillsPanel/PillsPanel.tsx | Missing | — | Obs. milaclone tags exist only on todo tasks and lists inside Quick notes. |
| Element filter / highlight | A filter set from the URL query (ids, query, context = search/notification/alias). It highlights matching elements on the board and auto-expands collapsed columns that contain a match. | client/element/elementFilter/*; Column.jsx | Missing | — | Obs. milaclone's only filtering is the tag chips and search inside Quick notes (public/js/quicknotes.js:406-414, 612-626). |
| **elementVisibility** | IntersectionObserver-based "content visible" tracking for lazy rendering. | client/element/elementVisibility/* | N/A | — | Obs. Performance only; not a user-visible feature. |
| **TEMPLATES** | A new board opens a template picker with built-in (CMS) templates, custom templates (from a "Templates" root board) and "Empty board", grouped into categories and sub-categories. A "clear template" toggle is included. | client/workspace/boardTemplatePickerPopup/*; templateTypes.ts; common/boards/boardConstants.ts (RootBoardTypes.TEMPLATES) | Missing | — | Obs. |
| **QUICK NOTES** | | | | | |
| What Quick notes is | A hidden per-user root board (`RootBoardTypes.QUICK_NOTES`) used as a scrollable inbox of **any** element (cards, to-do lists, images, files, links). It is not a view over to-dos elsewhere. | common/boards/boardConstants.ts; workspace/header/.../quickNotes/quickNotesElementsSelector.ts | Wrong | routes.js:211-232; public/js/quicknotes.js:11-22 | Obs. milaclone's Quick notes is a task manager that gathers **every todo card in the tree**. Notes, images and links never show up there. |
| Quick add (mobile) | A sheet with note card, to-do list, camera, photo picker and file upload. Each item is added to the Quick notes list. | client/workspace/quickNotes/MobileQuickAddSheet.tsx | Partial / Wrong | public/js/quicknotes.js:707-719, 802-833 | Obs. milaclone offers Note and Todo list only. The note goes on the current canvas, not into Quick notes, and new lists go on the root board. There is no image, camera or file option. |
| Desktop access + drag out to boards | A header popup lists the quick notes. You drag items from it onto boards, and can drop items into it except boards and columns (`quickNotesCanDrop`). | workspace/header/.../quickNotes/popup/QuickNotesPopup.tsx; quickNotesCanDrop.js | Partial | public/js/quicknotes.js:228-308 (phone popover) | Obs. milaclone has a desktop popover but no drag between it and the canvas. |
| Count badge | Counts the quick-notes items, or the search hits when a query is active. A "checked" marker is recorded when the popup closes. | workspace/header/.../quickNotes/QuickNotesCount.jsx; popup/QuickNotesPopup.tsx (userCheckedQuickNotes) | Wrong | public/js/quicknotes.js:246-264 | Obs. milaclone's badge counts every todo card in the tree. |
| Search | Content search over the quick-notes elements, including comments and labels. | QuickNotesCount.jsx (contentSearch) | Partial | public/js/quicknotes.js:612-660 | Obs. milaclone searches task text, notes and tags. |
| Smart views (Today / Starred / All / Completed), star, per-task note | Not found in Milanote's quickNotes sources. | client/workspace/quickNotes/* (absence) | Extra | public/js/quicknotes.js:33-39, 494-497, 561-600 | Inf from absence. These are milaclone's own additions. |
| Empty state / app-download prompt | Placeholder text, and a QR code to download the app on desktop. | QuickNotesEmptyPlaceholder.tsx; QuickNotesDownloadMobileAppPlaceholder.tsx | N/A | — | Obs. |

## Top gaps (ranked for a single-user, self-hosted clone)

1. **Trash is fake.** "Move to Trash" permanently deletes the item and any nested board subtree, with no confirmation, undo or restore (menus.js:82 → db.js:113). Data loss is the highest risk.
2. **Duplicate/paste of boards and columns loses their contents.** You get an empty board, or a column with no cards (clipboard.js:43-47). Milanote copies the whole subtree.
3. **No task nesting, task drag-reorder or drag-out to a new list.** These are core Milanote to-do interactions.
4. **No column collapse, and no child count on columns.**
5. **Quick notes has different semantics.** Milanote's is an inbox board for any element that you drag onto boards. milaclone's is a cross-board todo aggregator. Decide whether to keep this on purpose. Either way, due dates and tags never appear on canvas cards.
6. **No board shortcuts (alias) or templates.** Labels (coloured, on any card) with canvas filtering are next, followed by clones.


## 4 — Canvas & workspace interaction: Milanote 3.18.141 vs milaclone

Sources: Milanote paths are under the extracted source maps (printed with `src.cjs`). milaclone refs are
`/Users/ellingtonshephard/code_projects/milaclone/...` file:line. **[S]** = observed in source,
**[I]** = inferred (from names, comments or general Milanote knowledge, not traced end to end).

Background on milaclone: one global `keydown` handler (`public/js/main.js:34-52`), a single-selection model
(`state.selectedId`, `public/js/state.js:26`), an in-memory clipboard (`state.clipboard`), and no undo
history anywhere in the code.

---

## (a) Keyboard shortcuts

Milanote bindings come from `src/client/workspace/shortcuts/keyboardShortcuts.js` [S]. Labels come from
`src/client/workspace/shortcuts/modal/shortcutModalUtils.tsx` [S], `z` from
`src/client/canvas/zoom/ZoomToFitHandler.tsx` [S], and space and middle-mouse panning from
`src/client/canvas/grabScrollDecorator.jsx` [S]. "cmd" means ⌘ on Mac and Ctrl elsewhere. Rows that only
apply inside the text editor or drawing editor are grouped at the end; they belong to other areas but are
listed so the table is complete.

### Canvas / workspace

| Keys | Milanote action | milaclone behaviour |
|---|---|---|
| Backspace / Delete / cmd+Backspace / cmd+Delete | Moves the selection to **Trash**, which can be restored. Blocked without edit permission. | **Wrong.** Delete/Backspace hard-deletes the single selected card and its whole subtree. There is no trash and no undo (`main.js:46`, `routes.js:202-204`, `db.js:119`). cmd+Delete does the same because the modifier isn't checked. |
| alt+` | Move selection to "Unsorted notes" | Missing (no Unsorted concept) |
| ↑ ↓ ← → | Nudges the selection 1 grid unit. If nothing is selected, the default scroll happens. | Missing |
| shift+arrows | Nudges 5 grid units | Missing |
| cmd+F | Opens the board search popup ("View recent boards" / search) | Missing. The browser's find bar opens. |
| Esc / shift+Esc | Closes the top popup, else clears the element filter, else steps selection out one level | **Partial.** Disarms the tool and deselects, closes palette and context menu (`main.js:38`). There is no "step out one level". |
| Esc (presenting) | Leaves presentation mode | Missing (no presentation mode) |
| Return | Starts editing the selected element | **Done (similar).** Enter runs `renameSelected()`, which focuses the first editable field (`main.js:45`, `editing.js:38-47`). |
| cmd+Z | Undo | Missing (no undo system) |
| cmd+shift+Z / cmd+Y | Redo | Missing |
| cmd+alt+P | Toggle presentation mode | Missing |
| cmd+A | Select all elements | Missing. The browser selects page text. |
| cmd+D | Duplicate selection (alt+drag also duplicates, per the modal text) | **Partial.** Duplicates one card at +28px (`main.js:44`, `clipboard.js:69-75`). Boards duplicate as an **empty** board and columns lose their cards (see feature table). No alt+drag. |
| cmd+shift+↑ | Bring forward | Missing |
| cmd+shift+↓ | Send backward | Missing |
| alt+W / D / S / A | Align top / right / bottom / left | Missing |
| alt+H / alt+V | Align centre horizontally / vertically | Missing |
| cmd+alt+V | Paste styles | Missing |
| cmd+alt+shift+V / H | Distribute vertically / horizontally | Missing |
| cmd+Return | Create another element of the selected type (the "add another note, board or column" entry) | Missing |
| alt+Return | Element secondary-return action | Missing |
| cmd+shift+, / cmd+shift+. | Smaller / larger interface (changes grid size) | Missing |
| cmd+shift+D | Toggle dark mode | Missing (no dark theme) |
| ctrl+[ / ctrl+] (non-Mac; cmd+[ ] in the modal) | Navigate back / forward | **Wrong.** `openCanvas` uses `history.replaceState` (`main.js:31`), so browser Back leaves the app instead of returning to the previous board. |
| cmd+U | Go to parent board | Missing on desktop. On mobile only, the header Back button does this (`mobile.js:56-57`). |
| cmd+shift+U | Return down to the previously viewed child board | Missing |
| Space (tap, one element selected) | Opens the selected board, or opens the document/sketch/image modal; closes an element modal | Missing |
| Space (hold) + drag, or middle-mouse drag | Pans the canvas (grab-scroll) | **Wrong.** A plain left-drag on empty canvas pans (`tools.js:46-52`). Middle button also pans (`tools.js:36`). Space has no effect. |
| cmd+\\ | Toggle the Unsorted notes panel | Missing |
| / | Open the keyboard shortcuts modal | Missing |
| shift+D | Start drawing/annotation mode | Missing |
| cmd+, | Account settings | N/A (single user) |
| cmd+K (canvas) | Connect the selected elements with lines | Missing (no Line type) |
| cmd+S | "Fake save": swallows the browser save dialog | Missing. The browser save dialog opens. |
| z | Zoom to fit / scale to fit | Missing |
| cmd+= / cmd++ | Zoom in | Missing as a shortcut (only the `+` button, `viewport.js:75`). The browser zooms the page instead. |
| cmd+- | Zoom out | Missing as a shortcut (only the `−` button) |
| cmd+0 | Reset to 100% | Missing as a shortcut. The ⤢ button resets scale **and** position to (80,60) (`viewport.js:77`). |
| i | Colour eyedropper | Missing |
| cmd+C / X / V | Copy / cut / paste elements. This uses the **system** clipboard (handles images, URLs, text, HTML, files). | **Partial.** In-memory clipboard, one card only, not on the system clipboard (`main.js:41-43`, `clipboard.js`). See feature table. |
| cmd/ctrl-click, cmd+alt-click a board | Open board in a new tab / new window | Missing |
| @ (while typing) | Mention someone | N/A (single user) |
| (none in Milanote) n / l / t / b / c / m | — | **Extra in milaclone.** Arms the Note/Link/To-do/Board/Column/Comment tool (`main.js:47-51`). In Milanote, `c`, `v`, `e`, `x` and `1`–`4` are drawing-mode keys and `z` is zoom-to-fit, so a Milanote user's muscle memory won't match. |

### Editor / drawing / tasks (other areas, for completeness)

Bindings below are from `shortcutModalUtils.tsx` [S].

| Keys | Milanote action | milaclone behaviour |
|---|---|---|
| cmd+shift+1 / 2 / 0 / 9 | Large heading / normal heading / normal text / small text | Missing (plain textareas) |
| cmd+B / I / U | Bold / italic / underline | Missing |
| cmd+shift+U / cmd+shift+O | Bullet list / numbered list | Missing |
| cmd+K (editing) | Hyperlink | Missing |
| cmd+J | Highlight | Missing |
| cmd+shift+X | Strikethrough | Missing |
| cmd+> / cmd+" | Code block / quote | Missing |
| Tab / shift+Tab | Indent / un-indent | Missing |
| cmd+\\ (editing) | Align centre | Missing |
| Markdown at line start (`#`, `##`, `-`, `1.`, `[]`, `>`, ``` ``` ```, callout, `---`) | Auto-formatting | Missing |
| Return / alt+Return in a to-do | New task / add title | **Partial.** Enter adds a task and Backspace on an empty task removes it (`cards.js:163-164`). |
| cmd+shift+1 / 2 in a to-do | Due date / assign | Missing on the canvas (Quick notes has due dates) |
| Drawing: v, e, c, x, 1–4, cmd+S | Select, eraser, palette, previous colour, pen size, save | Missing (no drawing) |

---

## (b) Feature table

| Feature | Milanote behaviour | Milanote evidence (path) | milaclone status | milaclone ref | Notes |
|---|---|---|---|---|---|
| Zoom range | Max 300%. Min is dynamic: the smaller of a fit-content-with-20%-margin ratio and 40%. Zoom-to-fit caps at 80%. [S] | `src/client/canvas/zoom/zoomConstants.js` | **Wrong** | `viewport.js:32,57,87` | Fixed 20%–250%. Max is lower and the min isn't tied to content. |
| Wheel / trackpad | Wheel scrolls. cmd/ctrl+wheel and trackpad pinch (ctrlKey) zoom, with a pinch delta multiplier and smoothing (interpolation 0.25). [S] | `src/client/canvas/zoom/wheelZoomInteractionUtils.ts`, `zoomConstants.js` | **Done** | `viewport.js:80-93` | Zoom is anchored at the cursor. No inertia or interpolation smoothing. |
| Zoom UI | Header "View" button shows the zoom %. Its popup has a slider with +/- steps, "Reset to 100%" and "Scale to fit", plus the Presentation section. A zoom toast appears. [S] | `src/client/workspace/header/currentBoardHeader/view/{ViewUtil,ZoomPopupPanelSection}.tsx`, `canvas/zoom/toast/ZoomToast.tsx` | **Partial** | `index.html:23-28`, `viewport.js:75-77` | −/%/+/⤢ buttons with 1.2× steps. No slider and no scale-to-fit. The ⤢ button also resets pan. |
| Zoom to fit (`z`) | Animated fit-to-content [S] | `canvas/zoom/ZoomToFitHandler.tsx`, `zoom/utils/zoomToFitUtils.ts` | **Missing** | — | |
| Pinch zoom on touch | Yes [S] | `canvas/zoom/ZoomTouchHandler.jsx` | **Done** | `viewport.js:38-71` | |
| Per-board view memory | Restores the scroll position when returning to a board [I] | `canvas/canvasReturnStateService.ts` | **Done** | `viewport.js:19-26` (localStorage `cam:<id>`) | Per browser only. |
| Panning | Native scroll area. Space+drag or middle-drag grab-scrolls. Left-drag on empty canvas starts a **marquee**. [S] | `canvas/grabScrollDecorator.jsx`, `canvas/CanvasScrollArea.tsx`, `canvas/selection/*` | **Wrong** | `tools.js:46-52` | Left-drag pans, so marquee selection is impossible. |
| Grid & snapping | All positions are in grid units (8/9/10 px depending on breakpoint, changeable with cmd+shift+, and .). Drops and nudges snap to the grid. [S consts / I snapping] | `src/client/utils/grid/gridConstants.ts`, `gridActions.js`, `canvasElementDropAnimationStateManager.jsx` ("snap to the grid") | **Missing** | `drag.js:103-107` | Free pixel positions. The dot background is decorative and doesn't move or scale with the camera (`style.css:109-113`). |
| Marquee selection | Drag a rectangle on the canvas to select (long-press on touch) [S] | `canvas/selection/SelectionMarquee.jsx`, `selectionMarqueeMouseEventHandlerDecorator.jsx`, `selectionMarqueeLongPressEventHandlerDecorator.jsx` | **Missing** | — | |
| Multi-selection (shift/cmd-click, select all) | Set of selected IDs. All selection actions (move, colour, align, delete, copy) apply to every selected element. [S] | `element/selection/selectionActions.js` (`selectAllElements`), `selectedElementsSelector.js` | **Missing** | `state.js:26`, `editing.js:11-22` | Single `selectedId` only. |
| Selection toolbar actions | With a selection, the left toolbar swaps to contextual tools: Color, Icon, Rename, Title, Caption, Display, Labels, Reactions, Alignment, Distribute, Connect, Comment, More, Remove, Edit drawing, Line Start/End/Dashed/Weight/Label, and so on. [S] | `workspace/toolbar/config/toolDefinitions/toolbarSelectedToolConfig.ts` | **Partial** | `boardchrome.js:40-112`, `index.html:68-89`, `cards.js:79-110` | Boards swap the rail to Color/Icon/Rename/Delete. Other cards get a floating colour + delete badge. No align/distribute/labels/more. |
| Drag elements | React-DnD drag layer with 3D tilt (rotation from velocity), interpolated motion, drop shadow, and an animated drop that settles to the grid (if "3D effects" is enabled) [S] | `workspace/dnd/elementDragLayer/ElementDragPreviewRotator.tsx`, `elementDragLayerStateManagerInterpolationUtils.ts`, `canvas/canvasElementDropAnimationStateManager.jsx` | **Partial** | `drag.js:12-111` | Direct DOM move with no tilt, drop animation or snapping. Single element only. |
| Drag into / out of columns | Supported with insertion preview [I] | `element/dnd/*` | **Done** | `drag.js:35-41,72-120` | Highlights the column. Inserts by Y midpoint. |
| alt+drag duplicate | Yes (modal entry "Duplicate: cmd+D / opt+drag") [S text] | `shortcutModalUtils.tsx` | **Missing** | — | |
| Lock position | Context-menu toggle "Lock position" (checkbox-style). Locked elements can't move. [S] | `contextMenu/items/elementLayoutContextMenuItems.ts` (`toggleLock`) | **Done** | `clipboard.js:77-87`, `drag.js:19`, `menus.js:80`, `cards.js:97-110` | The label switches between Lock/Unlock Position instead of using a checkmark. |
| Z-order: bring to front / send to back | Context menu "Bring to front" / "Send to back", and cmd+shift+↑/↓ for forward/backward. Elements have a z "score". [S] | `elementLayoutContextMenuItems.ts`, `keyboardShortcuts.js` | **Missing** | `routes.js:98` (z = global max+1 on create only), `cards.js:65` | New items stack on top. Nothing can re-order afterwards. Dragging doesn't raise an element (except column-out drags, which are temporary: `drag.js:39`). |
| Align / distribute | Toolbar "Alignment" popup (left, centre-h, right, top, centre-v, bottom; needs ≥2 elements) and "Distribute" (horizontal/vertical) [S] | `toolbar/components/selectionTools/arrangementTools/**` | **Missing** | — | Needs multi-select first. |
| Element context menu (desktop) | Groups, in order: **Paste, Cut, Copy, Paste styles, Duplicate (or Duplicate linked board), Create synced copy, Move to trash** · **Rename** · board items (Open in new tab, Find original board, Create shortcut, Copy board link, Convert to template, Revert template) · media (Download original, Open file, Replace image, Add image, Copy link, Image aspect ratio) · Download SVG · **Group into column**, Connect with lines · Convert to sketch · Convert to note / document, Convert column to board · **Lock position** · **Bring to front, Send to back** · metadata. Each item shows only if its predicate passes. [S] | `workspace/contextMenu/configs/elementContextMenuConfig.ts`, `items/element*ContextMenuItems.ts` | **Partial** | `menus.js:66-103` | Has Cut, Copy, Paste, Duplicate · Rename · Lock · Move to Trash. The order differs (Milanote puts Paste first and Trash at the end of the first group). Missing: paste styles, open in new tab, copy board link, group into column, convert, bring to front / send to back. |
| Canvas (empty-area) context menu | Paste · Undo, Redo · Select all · New Note/Link/To-do/Line/Board/Column/Comment/Table · **Background** · New image or file [S] | `contextMenu/configs/canvasContextMenuConfig.ts` | **Missing** | — | Right-clicking the canvas shows the browser menu. |
| Board background colour | Background picker from the canvas menu: Grey (default `#f0f1f2`), Blue, Green, Yellow, Warm grey [S] | `src/common/colors/colorConstants.ts` (`CANVAS_COLORS`), `canvas/background/boardBackgroundConstants.js`, `contextMenu/BackgroundColorPicker.tsx` | **Missing** | `style.css:109-113` | One fixed dotted background. |
| Element colour palette | `COLORS`: None, Grey `#bbbec3`, Cyan `#62dbc8`, Green `#7cd651`, Brown `#d58558`, Yellow `#ffd14d`, Orange `#ff8d48`, Red `#ff5757`, Pink `#ff6ed4`, Purple `#ad6fff`, Blue `#4ebafd`, Deep blue `#5882f8`. Columns use lighter variants. Background mode adds Transparent. Also a custom colour picker (hex/wheel) and an eyedropper. [S] | `src/common/colors/colorConstants.ts`, `toolbar/components/selectionTools/colorTools/{CustomColorTool,CustomColorInput}.jsx`, `popup/colorPopupConstants.ts` | **Wrong** | `state.js:12`, `style.css:19-22`, `menus.js:19-26` | 12 swatches: slate, gray, teal, green, brown, yellow, orange, red, pink, purple, blue, indigo. Extra **slate**, **no "None" (can't clear a colour)**, all hexes differ (e.g. red `#ef4b4b` vs `#ff5757`), no custom colour, no eyedropper. |
| Left toolbar (desktop) tools and order | Note, Link, To-do, Line, Board, Column, Comment, Table, then **More** (Sketch, Color swatch, Document, Audio, Map, Video, Heading), divider, Image, Upload, Draw. Primary tools are user-configurable; the rest live in More. [S] | `workspace/toolbar/config/toolbarMainToolListConfig.ts`, `primaryToolsConstants.ts`, `toolbar/components/moreTool/*`, `user/account/accountV2/modal/toolbar/toolbarScreenConfig.ts` | **Partial** | `index.html:32-67` | Note, Link, To-do, Board, Column, Comment, divider, Image, Upload. Missing: Line, Table, More menu, Draw, and toolbar customization. Comment comes before Board/Column relative to Milanote's order, and Line is absent. |
| Tool placement | Click a tool to create at a default spot, or drag the tool onto the canvas [I] | `toolbar/components/elementTools/ElementTool.tsx` | **Wrong** | `tools.js:13-44` | "Arm then click the canvas" flow with a toast. Dragging a tool from the rail isn't supported. |
| Double-click empty canvas | Creates a note at that point [S] | `src/client/canvas/canvasDoubleClickShortcutDecorator.js` | **Missing** | — | |
| Type-to-edit | Typing with one element selected is buffered into it [I] | `canvas/utils/useTypingBufferListener.ts` | **Partial** | `drag.js:53-54,63-70` | A single click enters edit mode straight away instead. |
| Drop OS files/images onto canvas | Creates image/file elements at the drop point. On an empty board, several files are laid out masonry-style. [S] | `canvas/dnd/canvasFileDropUtil.ts`, `canvas/dnd/canvasDropTargetDecorator.js` | **Missing** | — | No `drop`/`dragover` listeners. Uploads only through the Image/Upload tools (`tools.js:55-86`). |
| Drop URLs/text from browser | Creates link/text elements [I] | `canvas/dnd/canvasDropTargetDecorator.js` | **Missing** | — | |
| System-clipboard paste | Paste order of handlers: Milanote element payload (from HTML attribute), caption text onto selected image, task-list paste, **URL → link element**, **files → image/file**, **HTML/plain text → note**. Positioned at the viewport centre or preserving relative layout. [S] | `workspace/shortcuts/clipboard/WorkspaceClipboardHandler.jsx`, `workspaceClipboardPasteUtils.ts`, `clipboardPastePositionUtils.ts` | **Missing** | `main.js:43` (`preventDefault` then internal paste only) | Pasting a screenshot, URL or text does nothing. |
| Copy/cut/paste elements | Multi-element, via the system clipboard, so it works across tabs and reloads. Keeps relative layout and z-order. Paste lands centred in the viewport. Cut is a real move. [S] | `clipboardPastePositionUtils.ts`, `getElementClipboardHtmlString.js` | **Partial** | `clipboard.js:13-67` | One card, in memory only (lost on reload). Pastes at selected+24 or (104,104), not the viewport. "Cut" deletes the original only when you paste. Board copies get a **fresh empty child canvas** (`clipboard.js:43-47`, `routes.js:106-117`). Column copies drop their child cards. |
| Duplicate | cmd+D duplicates the selection, deep-copying boards [I for deep copy] | `element/actions/elementShortcutActions.js` (`duplicateSelectedElements`) | **Wrong** | `clipboard.js:69-75` | A board duplicate is empty and a column duplicate has no cards: data the user expects isn't copied. |
| Undo / redo | Redux undo middleware with transactions. cmd+Z / cmd+shift+Z. Header Undo/Redo buttons. Canvas context-menu Undo/Redo. [S] | `src/client/utils/undoRedo/*`, `workspace/header/workspaceToolsHeader/undoRedo/UndoRedoUtil.tsx` | **Missing** | — | Combined with hard delete, a mis-press loses data permanently. |
| Trash | "Move to trash" (restorable) [S label / I restore UI] | `elementCoreContextMenuItems.ts` (`delete` → `moveToTrash`) | **Wrong** | `menus.js:82`, `routes.js:202-204`, `db.js:119-130` | The menu says "Move to Trash" but the delete is permanent and recursive. |
| Header: breadcrumbs | Breadcrumb list of the board path, plus a current-board title the user can click to rename [S components / I rename] | `workspace/header/workspaceToolsHeader/AppHeaderBreadcrumbs.jsx`, `currentBoardHeader/CurrentBoardHeaderTitle.jsx` | **Partial** | `cards.js:31-44`, `index.html:16` | Clickable ancestor crumbs. Only the current crumb gets its real colour chip (`cards.js:38`). The current board title can't be edited from the header. |
| Header: buttons | Workspace tools: Undo/Redo, Board search, Quick notes, Notifications, Help, Refer, Account. Current board: status/saving feedback, Share, **View** (zoom + presentation), **Export**, template status. [S] | `workspaceToolsHeader/WorkspaceToolsHeader.jsx`, `currentBoardHeader/CurrentBoardHeader.jsx` | **Partial** | `index.html:14-30` | Fake macOS traffic-light dots, crumbs, phone/Quick-notes popover, a stub "Export", and zoom controls. Missing: undo/redo, search, help/shortcuts, view popup. |
| Presentation mode | Present from the View popup or cmd+alt+P. Fullscreen, Esc exits. Settings: Focus on selected cards (click to focus an element), Hide comments, Prevent editing. [S] | `workspace/presentation/*`, `currentBoardHeader/view/PresentationModePopupPanelSection.tsx` | **Missing** | — | |
| Export | Board export popup. Current layout: PDF (standard / high quality), PNG. Linear document (optionally including sub-boards): Word (.docx), Markdown, Plain text. "Download all files" as a ZIP of the board's media. Per-element export too. [S] | `src/common/export/exportConstants.ts`, `workspace/export/ExportPopupForBoard.tsx` | **Wrong** (stub) | `index.html:22`, `viewport.js:78` | The button only shows the toast "Tip: your boards auto-save to the server". |
| Board search panel | cmd+F opens a panel searching **boards**, with sort Last viewed / Last modified / Relevance, a "shared with" filter, date markers, and fetch-more [S] | `workspace/header/workspaceToolsHeader/boardSearch/{BoardSearchPanel,BoardSearchModifiers}.tsx` | **Missing** | — | milaclone search exists only inside the mobile Quick notes (to-dos). |
| Shortcuts help modal | `/` opens a sectioned, scroll-spy modal listing every shortcut and gesture [S] | `workspace/shortcuts/modal/ShortcutsModal.jsx` | **Missing** | — | |
| Interface size / dark mode | cmd+shift+,/. changes grid size; cmd+shift+D toggles theme [S] | `keyboardShortcuts.js`, `utils/grid/gridActions.js` | **Missing** | — | |
| Navigation history | Browser back/forward walks boards; cmd+U goes to parent [S] | `navigationKeyboardShortcutActions.js` | **Wrong** | `main.js:31` (`replaceState`) | Hash deep-links work (`main.js:61-64`), but history entries aren't pushed. |
| Open board | Double-click (or Space when selected) opens it; cmd-click opens a new tab [S] | `navigationKeyboardShortcutActions.js` (`handleSpaceShortcutAction`) | **Partial** | `cards.js:236-250` | Double-click / double-tap only. |
| Resize | Width resize snapped to the grid [I] | — | **Partial** | `drag.js:122-139` | Width 120–900 px, unsnapped, single element. |

---

## (c) Top gaps, ranked for a single-user self-hosted clone

1. **No undo/redo, and delete is permanent.** "Move to Trash" hard-deletes the whole subtree, and there's no cmd+Z (`routes.js:202-204`, `menus.js:82`, `main.js:46`). This is the highest data-loss risk. Even a server-side soft-delete plus a one-level client undo stack would close most of it.
2. **Duplicate and copy/paste lose content.** Duplicating or pasting a board gives an empty board, and a column loses its cards (`clipboard.js:43-47`). The clipboard is in-memory and single-card only.
3. **No system clipboard paste or OS drag-and-drop.** Pasting a screenshot, URL or text, or dropping files/links onto the canvas, does nothing. These are core Milanote capture flows (`WorkspaceClipboardHandler.jsx`, `canvasFileDropUtil.ts`).
4. **No multi-select or marquee.** Left-drag pans instead (`tools.js:46-52`). This also blocks select-all, group moves, align/distribute and group delete. Fix: switch panning to space/middle-drag (both are in Milanote), then add a marquee and a `selectedIds` set.
5. **Navigation is wrong.** `replaceState` breaks browser Back/Forward between boards (`main.js:31`). There's no cmd+U, no Space-to-open, and the board title can't be renamed from the header.
6. **No z-order control and no grid snapping.** Bring to front / send to back is missing, and dragging doesn't raise the card. Positions are free pixels, so layouts drift. Arrow-key nudge is missing too.
7. **Export is a stub** (`viewport.js:78`). For a self-hosted single user, a Markdown/plain-text linear export and a ZIP of uploads are the most valuable formats (PNG/PDF less so).
8. **Shortcut and zoom parity.** Missing: `z` zoom-to-fit, cmd+=/−/0 (the browser zooms the page instead), the `/` shortcuts modal, the empty-canvas context menu with board background colours (Grey/Blue/Green/Yellow/Warm grey), and double-click to create a note. The palette also differs from Milanote's 11 colours + None (milaclone has an extra slate, no "None", and different hexes).


## Area 5: Platform and cross-cutting features (Milanote 3.18.141 vs milaclone)

Milanote paths are relative to the extracted sources (`node src.cjs <path>`). milaclone refs are `file:line` in `/Users/ellingtonshephard/code_projects/milaclone`.
**[obs]** means I read it in source. **[inf]** means I inferred it from file/constant names without reading the logic.

## Feature map

| Feature | Milanote behaviour | Milanote evidence (path) | milaclone status | milaclone ref | Notes |
|---|---|---|---|---|---|
| In-board content search / highlight | Matches the query against element text and highlights hits on the open board. Indexed: board/column/task-list titles; card/document title + caption + rich text; image caption + auto image keywords; link title + URL + caption; file title + filename + caption; task text; line labels; table cell content; comment threads attached to an element; label names. Clones count as hits **[obs]** | src/client/components/search/contentSearch/elementContainsSearchQuery.js, matchUtils.js, elementCommentsContainsSearchQuery.js | Missing | — | Nothing searches canvas items. The desktop top bar has no search box. |
| Global board search panel | Header panel that searches every board. Results come from a server index merged with live results for the current board. Sort by last viewed / last modified / relevance; filter by "shared with user"; each result shows its ancestor breadcrumb, a date marker and "fetch more"; when the query is empty it shows recent history **[obs]** | src/client/workspace/header/workspaceToolsHeader/boardSearch/{BoardSearchModifiers.tsx, state/boardSearchFilterUtils.ts, state/useFetchHistoryOnMount.ts, results/*} | Missing | — | Cheap to add for a single user: SQL `LIKE` over `canvases.title` plus `items.data`, returning breadcrumbs via the existing `breadcrumb()` (db.js:90). |
| Mobile search sheet | Search tool in the mobile toolbar opens a search bar on a bottom sheet **[inf]** | src/client/mobile/toolbar/tools/searchTool/*, mobile/structural/sheet/searchBar/* | Partial | public/js/quicknotes.js:611-673, public/index.html:222-231 | Quick notes search only covers todo task text, task notes and tags. It never searches boards or cards. |
| Undo / redo | Redux middleware keeps a per-user undo stack (limit 500, sliced to 400). Remote users' actions are excluded, operations are grouped into transactions, and clipboard, label, comment and clipper ops are covered. Electron Edit menu exposes undo/redo. On iPad a synthetic Cmd+Z is used; on mobile you shake for an undo menu **[obs]** | src/client/utils/undoRedo/{undoRedoConstants.js, middleware/shouldAddUndo.js, undoRedoBrowserUtils.ts}, src/client/capacitor/hooks/useAttachGestureShake.ts, src/electron/main/appMenu.js | Missing | public/js/main.js:34-52 (no Cmd+Z handler) | Every edit is an immediate PATCH with no history. Combined with hard delete, mistakes can't be reversed. |
| Offline / local cache | The client keeps elements in IndexedDB (localCache, mnObjectsIdb) and runs a persistence-layer Web Worker that rehydrates state on load. A connection state machine (connected / connecting / interrupted / disconnected / idle) shows a "trying to reconnect" message or a reconnecting overlay. App-visibility tracking and a multiple-refresh guard. Settings can clear the local cache. The Electron main process has a persisted send buffer **[obs for states + IDB; inf for offline edit queueing]** | src/client/offline/{cache/localCache.ts, persistence/worker/*, visibleConnectionStatus/visibleConnectionStatusTypes.ts, appServerConnection/*}, src/client/workspace/localCache/ClearAppLocalCache.tsx, src/electron/main/electronPersistedSendBuffer.js | Missing | public/js/api.js:4-14 (no `res.ok`/retry), public/js/editing.js:55-56 (no `.catch`) | No service worker, manifest or cache, and no "disconnected" indicator. Failed saves on the canvas fail silently. Only Quick notes toasts "Could not save" (quicknotes.js:141). |
| Realtime collaboration / presence | Socket.io collab server. Live cursors with name tags and pointer/pen/eraser variants, remote selected-element outlines, and a sound when a remote user selects or deselects **[obs]** | src/client/remoteActivity/liveCollaboration/{socket/*, cursorTracking/*}, remoteActivity/remoteSelectedElementsSelector.js, sounds/soundConstants.ts | Out-of-scope | — | Single-user. But one person editing on phone and desktop together is a real case (see robustness #3): a cheap "reload on focus" or poll is worth more than presence. |
| Sharing / permissions / password protection | Share board with users or via link (permission tokens in the URL), permission toasts for guest vs. user, password-protected boards and previews **[inf from names]** | src/client/workspace/{sharing/*, permissions/*, passwordProtection/*} | Out-of-scope | public/js/mobile.js:59-62 | milaclone's "share" just copies `location.href`. There is no auth at all (server.js:7-13). Access control comes only from Tailscale and the loopback bind (docker-compose.yml). |
| Compose (share/invite modal) | Modal for messaging or emailing a board to recipients (user tag input, recipient pills), plus a referral-invite email flow **[obs file names; inf behaviour]** | src/client/compose/{components/ComposeMessageModal.jsx, composeEmail/referral/*} | Out-of-scope | — | Needs accounts and email. |
| Notifications | Activity notifications with per-board notification preferences, push notifications (web push + mobile), and an unread badge on the Electron dock **[inf + obs badge middleware]** | src/client/notifications/{push/*, preferences/*}, src/electron/main/notificationBadgeMiddleware.js | Out-of-scope | — | Multi-user driven. |
| Inbox ("Unsorted") | Collapsible inbox side panel (open/closed state) that holds unsorted items, e.g. content sent from the mobile share extension. You drag items from it onto boards. BoardSections include INBOX, TRASH, QUICK_NOTES **[obs constants; inf flow]** | src/client/inbox/*, src/common/boards/boardConstants.ts, src/client/capacitor/actions/shareExtensionActions.ts | Missing | — | The closest analogue is the desktop "From your phone" popover (index.html:18-20, quicknotes.js:304), which only lists todos. There is no place to capture loose notes or files to sort later. |
| "Harvester" | The only `harvester` in the bundle is New Relic's browser-agent telemetry harvester, not a Milanote feature **[obs]** | build/app-bundle.js.map (New Relic agent code) | N/A | — | Milanote's real web clipper is a separate Chrome extension (only its extension ID is in the Electron config), so its source isn't in this asar. In-app "clipper" means dragging selected text out of a card to make a new card (desktop only) **[obs]**: src/client/element/card/clipper/CardClipper.tsx. The card-text clipper belongs to the cards area. |
| Electron desktop shell | Menus: File › Copy Board URL (Cmd+L); Edit with undo/redo/cut/copy/paste/paste-and-match-style/select-all and spell-check; View with reload, devtools, zoom and fullscreen; History back/forward (Cmd+[ / Cmd+]); Preferences (Cmd+,) opens account settings; Help center. Auto-update polls every 30 min with manual download. Native dark theme comes from `nativeTheme`. Dock badge shows unread notifications. The preload exposes `desktopIntegration` (state sync, session ID, remote-action/client-action IPC, lifecycle channel `electron-window-lifecycle-state`, fullscreen class, auth token). I found no custom-protocol deep-link handler in main.js **[obs]** | src/electron/main/appMenu.js, autoUpdate.js, electronThemeManager.js, notificationBadgeMiddleware.js; windowPreload.js; electron.config.js | Out-of-scope (Missing) | — | milaclone is browser-only, which is fine for self-hosting. The useful bits to port are web-level: Cmd+[ / Cmd+] for back/forward (milaclone uses hash routing with `replaceState`, main.js:31, so **browser Back doesn't move between boards**), and a copy-board-URL shortcut. |
| Mobile app (Capacitor) | Native shell with: share extension (shared text becomes a card, shared files become file elements); deep links for app.milanote.com URLs; shake for an undo/redo sheet with haptics; app lifecycle; push notifications; quick notes actions; portrait lock; app-review prompt; native launch screen; crash recovery **[obs for share/deeplink/shake; inf rest]** | src/client/capacitor/hooks/*, capacitor/actions/*, platform/screenOrientation/* | Out-of-scope (native) / Partial (web) | public/js/mobile.js:26-89, public/js/viewport.js:36-71, public/js/quicknotes.js | milaclone has a mobile web layout with header, footer tabs, tool tray, pinch zoom, double-tap to open a board and Quick notes. Missing: bottom-sheet context menus for cards, a mobile search tool, a rich-text tool, and long-press menus. A PWA manifest plus the Web Share Target API would cheaply cover the share extension. |
| Mobile workspace screens | Boards page with header and editing modes; structural bottom sheets (with menu and search bar); toolbar with tabs, utils, image and rich-text tools; mobile inbox; mobile notifications; mobile sharing **[inf from paths]** | src/client/mobile/{boardsPage,structural/sheet,toolbar,inbox}/* | Partial | public/index.html:102-140, public/js/mobile.js | The footer Export item shows a toast and does nothing (mobile.js:71). |
| Theme / dark mode | Three modes: match browser/OS, light, dark. Dark-mode suggestion service. Heading style manager. Electron follows the native theme **[obs constants]** | src/client/theme/{themeConstants.js, ThemeManager.jsx, darkModeSuggestionService.js}, src/client/electron/store/electronTheme* | Missing | public/style.css:1-23 (light tokens only, no `prefers-color-scheme`) | Colours are already tokenised on `:root`, so adding a `prefers-color-scheme: dark` block is cheap. Quick notes has its own token set to cover too. |
| Interface settings | Toggle for 3D drag-and-drop effects (card tilt while dragging) **[obs]** | src/client/interfaceSettings/interfaceSettingsConstants.js | Missing | — | Low value. |
| UX sounds | 20 sound IDs at a fixed volume of 0.07: card pickup/drop, board drop, delete, error, line connect, checkbox tick/untick, popup open, reaction, remote select/deselect, rollover, comment add, switch toggles, new task. A selector controls whether sound is on **[obs]** | src/client/sounds/{soundConstants.ts, soundManifest.ts, soundEnabledSelector.ts} | Missing | — | Low value. |
| Localisation | i18n with a CDN backend. English, Spanish, French and Portuguese, plus German, Chinese, Russian, Polish, Japanese, Dutch, Italian and Korean behind experiments; per-account locale preference **[obs]** | src/client/localisation/{localizationConstants.ts, i18n/initI18n.ts} | Missing | public/index.html:2 (`lang="en"`, strings hard-coded) | Out-of-scope in practice for a personal clone. |
| Onboarding | First-run segment/skills picker, onboarding tooltips (about 30 tooltip components) with a config, and portrait lock during onboarding on phones **[inf from paths]** | src/client/workspace/onboarding/{config,tooltips}/*, src/client/user/account/onboarding/segmentPicker/* | Missing | db.js:64-71 (seeds an empty `Home`) | Low value for single-user. An empty-state hint on an empty Home would be enough. |
| Export | Board export as PDF, PNG, DOCX, Markdown or plain text, in canvas layout or linear format, at regular or high quality. Per-element export. "Download all files" ZIP of board media, with generating/downloading/error states **[obs]** | src/common/export/exportConstants.ts, src/client/workspace/export/{ExportPopupForBoard.tsx, ExportingZipContainer.jsx} | Wrong | public/index.html:22, public/js/viewport.js:78, public/js/mobile.js:71, public/index.html:246 | The visible "Export" buttons only toast "Tip: your boards auto-save to the server". A Milanote user would expect a download. Cheapest real version: `GET /api/export` returning the JSON tree, or a Markdown outline plus a ZIP of the uploads. |
| Import / backup | Milanote imports via the web clipper and the share extension. No bulk import was found in this area **[inf]** | — | Missing | — | No backup or restore. The only "backup" is copying `data/board.db` (WAL) and the uploads volume by hand. |
| Trash (restore deleted) | Toolbar trash popup lets you restore deleted elements, with an "empty trash" footer. A board section TRASH exists separately from DELETED **[obs paths + constants]** | src/client/workspace/toolbar/trash/{Trash.jsx, popup/*}, src/common/boards/boardConstants.ts | Wrong | public/index.html:250 ("Move to Trash"), routes.js:202-206, db.js:119-140 | The label promises a trash but the action hard-deletes the item and its entire nested board subtree. See robustness #1. |
| Platform support / version gating | Unsupported-browser and blocked-cookie full-screen warnings, forced-update prompt, form-factor detection **[inf]** | src/client/platform/components/* | Out-of-scope | — | Not needed. |

## milaclone robustness issues (would bite a single user)

1. **Delete is permanent, with no confirmation or trash, and cascades.** `DELETE /api/item/:id` (routes.js:202-206) calls `deleteItemDeep` (db.js:119-140). That wipes the board's child canvases and every item in them in one transaction. The UI labels it "Move to Trash" (index.html:250), and Backspace/Delete on a selected item fires it with no confirm (main.js:46, editing.js:61-62). There is no undo either. One stray Backspace on a board card can destroy a whole project.
2. **Cut-and-paste of a board or column loses everything inside it.** `pasteClipboard` (clipboard.js:41-58) recreates a board with `childCanvasId` stripped, so the server makes a new empty canvas (routes.js:106-117). It then calls `api.remove` on the original, which deep-deletes the original subtree. A column's child cards are not in the clipboard payload (clipboard.js:13-24), so cutting a column deletes its cards (db.js:125-127). Copy/duplicate of a board gives an empty board titled "… copy". Milanote users would expect a deep copy.
3. **Edits to one card can be dropped by the shared debounce.** `saveData` (editing.js:50-59) keeps one timer per item and, when it fires, sends only the most recent `patch`. On a note card, editing the title and then the body within 400 ms (cards.js:128-129) never sends the title PATCH. The UI shows it, but it is gone after reload. Fix: accumulate pending fields per item, like quicknotes.js:123-130 already does.
4. **No flush on unload.** Pending canvas saves (400 ms, editing.js:55) and Quick notes saves (200 ms, quicknotes.js:129) are dropped if the tab or phone app is closed or backgrounded. Nothing listens for `pagehide` or `visibilitychange`. Use `fetch(..., {keepalive:true})` or flush on `pagehide`.
5. **Last-write-wins on whole arrays across devices.** A todo's `tasks` array is always sent whole: from the canvas (cards.js:159-176) and from Quick notes (quicknotes.js:145). The server shallow-merges `data` (routes.js:146), so the array is replaced. With a phone in Quick notes and a desktop canvas open together (the advertised workflow), the second writer silently reverts the other's task edits. Neither view refreshes on focus. Quick notes `load()` is only skipped while a save is pending (quicknotes.js:107). Cheap fix: refetch on `visibilitychange`, and optionally an `updatedAt` check that returns 409.
6. **Silent save failures.** `api.*` never checks `res.ok` (api.js:5-13). The canvas `saveData` and drag/resize PATCHes have no `.catch` (editing.js:56, drag.js:99-135, menus.js:23). If the server is down or restarting, edits are lost with no indication.
7. **Uploads.**
   - **(a) Stored XSS:** `ALLOWED_UPLOAD` accepts any `text/*` (including `text/html`) and `image/svg+xml` based on the client-declared mimetype (routes.js:23-34). The file keeps its original extension (routes.js:41) and is served from the app's own origin by `express.static` (server.js:12). Opening such a file runs script with full API access. The risk is lower behind Tailscale but real.
   - **(b) Orphaned files:** files are never removed when their image/file item is deleted, so the uploads volume only ever grows.
   - **(c) Silently dropped files:** a rejected type returns 400 "no file" (routes.js:231) with no explanation.
8. **Unvalidated reparenting.** PATCH accepts any `parentItemId` (routes.js:144, 188) with no check that the target exists, is a column, or doesn't create a cycle. `deleteItemDeep` guards cycles, but rendering may not. Moving a column via `canvasId` (routes.js:145) does not move its child cards.
9. **No backup or export.** Combined with #1 and #2, an accidental deep delete is unrecoverable unless the user has copied the SQLite file and WAL themselves.
10. **Browser Back doesn't navigate boards.** `openCanvas` uses `history.replaceState` (main.js:31), so Back leaves the app instead of returning to the parent board. On mobile you can only go up via the header back button (mobile.js:55-58).

## Top gaps (ranked for a single-user, self-hosted clone)

1. **Trash plus undo for deletes.** Soft-delete (`deletedAt` column, a Trash list with restore) and at minimum Cmd+Z for the last delete or move. Fixes the biggest data-loss risks (#1, #2).
2. **Save reliability.** Merge pending fields per item, flush on `pagehide`, check `res.ok` and surface errors, refetch on focus (#3–#6). Cheap and prevents silent data loss.
3. **Global search.** One SQL endpoint over canvas titles and item `data` text, plus a results panel with breadcrumbs. The Milanote indexed-field list above is the spec.
4. **Real Export/backup.** Replace the placeholder Export toast with a JSON/Markdown + uploads ZIP download, and optionally a matching import.
5. **Dark mode.** A `prefers-color-scheme` token override, since colours are already tokenised. Optionally a light/dark/system toggle like Milanote's THEMES.
6. **Navigation history and mobile capture.** Use `pushState` so Back/Forward and Cmd+[ / Cmd+] work. Add a PWA manifest plus Web Share Target to feed an "Unsorted"/inbox board, the web equivalent of the Capacitor share extension.

Out of scope: realtime presence, sharing/permissions/password protection, compose, notifications, Electron shell, localisation, sounds, onboarding.
