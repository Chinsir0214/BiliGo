---
version: alpha
name: BiliGo
description: Quiet, compact desktop controls for choosing and downloading Bilibili media.
colors:
  ink: "#191919"
  action: "#222222"
  background: "#f7f7f5"
  surface: "#ffffff"
  border: "#e6e6e2"
  muted: "#888888"
typography:
  sans:
    fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif'
rounded:
  control: "4px"
  option: "8px"
spacing:
  sidebar-width: "220px"
  content-gutter: "clamp(24px, 6.5vw, 96px)"
components:
  primary-button: { }
  input-card: { }
  selection-list: { }
---

# BiliGo design context

## Product and visual direction

BiliGo is a Chinese-language Windows desktop tool for choosing Bilibili media and saving it locally. Its main job is to make a link, download options, parsed items, and task status readable in one workflow. The existing interface uses a dark navigation rail against a light work surface, compact labels, and restrained borders. The resource title and selected items, not decoration, carry the emphasis.

`src/styles.css` owns the runtime tokens, application shell, dialogs, and toast. `src/styles/controls.css` owns reusable form controls and actions, and `src/styles/views.css` owns the download, history, and settings layouts. The palette above maps to `--ink`, `--accent`, `--canvas`, `--surface`, `--line`, and `--muted` in that order.

## Layout and type

The sidebar is 220px wide in a standard window, shrinking to icon navigation below 800px. Main content uses the documented responsive gutter. The top bar, input card, and selection panel form one vertical flow; within the selection panel, a bounded list scrolls independently for large collections. At short desktop heights, the parsed selection state may compress its introductory content so the selection and download action stay in view. The input form must remain reachable and the page must retain vertical scrolling.

All interface text uses Microsoft YaHei UI, with Microsoft YaHei and the system sans-serif as fallbacks. Download percentages, speed, time remaining, and media durations use tabular numerals to keep the digits aligned. Titles can wrap to two lines where necessary and long local paths wrap to fit adjacent controls. The interface currently has one light theme.

Navigation, toolbar actions, empty states, and form controls use the Regular style from Microsoft's Fluent System Icons. The application bundles the SVGs and their license in `src/assets/fluent`. [Icon source](https://github.com/microsoft/fluentui-system-icons/tree/a3de63245b4fa49c30e20d9838593a105affe774)

## Components and states

Primary buttons use the dark action color; secondary buttons use a light surface and border. Inputs, select controls, check options, resource rows, and navigation have visible selected or hover states. The shared Select/Listbox owner is `initCustomSelect` in `src/renderer/ui/custom-select.mjs`: each HTML select stores the value and is hidden after initialization, while the authored popup handles interaction. Subtitle language multiselect uses the same popup behavior with explicit multiple-selection semantics. Keyboard focus on resource rows and their actions must remain visible. Disabled content choices stay visibly disabled; loading and failure feedback uses existing task and toast patterns. Keep selection labels, duration, and the download action in the same order at narrow widths.

Do keep the compact, utilitarian desktop style and preserve full resource titles where space allows. Do not introduce decorative color or hide an essential download option merely to fit a viewport.
