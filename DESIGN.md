---
version: alpha
name: Cobalt Studio
description: A calm desktop download workspace with a clear media and file hierarchy.
colors:
  primary: '#3565df'
  primary-hover: '#2753c2'
  background: '#f5f7fa'
  surface: '#ffffff'
  sidebar: '#f6f8fb'
  text: '#202c3e'
  muted: '#68778d'
  border: '#e5eaf1'
  success: '#237655'
  danger: '#bc3f46'
typography:
  sans:
    fontFamily: "'Cabinet Grotesk', 'Microsoft YaHei UI', 'PingFang SC', 'Noto Sans SC', sans-serif"
  mono:
    fontFamily: "'Cascadia Mono', 'Consolas', monospace"
rounded:
  DEFAULT: '9px'
  sm: '6px'
  lg: '16px'
spacing:
  page-gutter: '28px'
  group-gap: '18px'
  control-height: '40px'
components:
  button: {}
  input: {}
  select: {}
  switch: {}
  task: {}
  dialog: {}
---

# Cobalt Studio Design System

## Overview

The reference is a focused desktop media library: a quiet sidebar, an immediate download command, readable original content, and restrained file metadata. This is a product workspace for Chinese-speaking desktop users, with an existing companion mobile route. Do not turn it into a marketing page, add decorative statistics, or introduce scroll hijacking.

The user requested a unified refinement of the running download list and settings. Keep the Cobalt mark, light blue action language, existing routes, task operations, settings, and local-only permissions. Phone connectivity troubleshooting is paused at the user's request.

## Token Ownership

Runtime CSS remains canonical: `public/theme.css` owns palette, font, shape, focus, and control-size tokens. This document mirrors accepted values and explains usage. `public/styles.css` imports that theme and `public/workspace.css`; `public/mobile.css` imports the same theme. Shared `post-view.js` owns original-post presentation on both surfaces. No independent screen-local token systems.

## Colors

White work surfaces and a faint blue-gray sidebar frame the content. Blue is reserved for primary actions, selection, focus, and interactive feedback. Success and danger retain their semantic roles. The dark green and amber Cobalt mark remains the brand anchor. Muted text remains legible; metadata never takes priority over the original post.

## Typography

Cabinet Grotesk is bundled locally in regular, medium, and bold WOFF2. Chinese text uses the installed Microsoft YaHei UI or PingFang SC fallbacks. Controls use 13px text and a normal line height, dialog headings 21px, and post captions 15px. Do not add a page heading or subtitle above the downloading/completed tabs; the user explicitly reserves this space for task operations. Timestamps and progress use tabular numerals. A post caption is primary, author and publication date secondary, and filename and completion details tertiary.

## Layout

The desktop shell owns the viewport and preserves its existing internal task-list scroller. A 176px sidebar and 28px content gutters become 158px and 22px below 1000px. The toolbar is 72px high; its input, primary/secondary buttons, and icon hit targets are all 40px with matching vertical centers. Text, icons, badges and controls must be centered as rendered, including text in other components. The task tabs begin immediately below the toolbar in a 58px row with no decorative title or subtitle. The top command stays in one row at the native app's 900px minimum width. Task rows pair a stable 112x80 preview with flexible text and visible actions; at smaller desktop widths, previews are 96x76.

Settings use a centered 680px modal with a fixed header/footer and a separately scrolling body. Two output columns contain four controls without empty cells; the path spans both columns. Below 720px, fields form a single column. Scrollbars remain visible. Long paths stay inside inputs, long URLs truncate visually while preserving their full link/tooltip, and expanded post text wraps.

## Elevation & Depth

Use borders and tonal differences for the workspace; reserve elevated shadows and backdrop blur for dialogs and toasts. Task rows have a subtle border and one hover treatment. Avoid nested decorative cards, gradients behind content, or arbitrary badges.

## Shapes

Controls use a 9px radius, dialogs 16px, secondary compact details 6px. File thumbnails use the same control geometry. The Cobalt logo retains its established shape. Status dots and switch thumbs are the only circular UI accents.

## Components

All desktop input and native select fields share a 40px height, font, padding, border, focus ring, and authored chevron. The select popup itself remains operating-system owned, preserving native keyboard and accessibility behavior. The thumbnail switch is a labeled native checkbox with switch semantics. Primary buttons are blue with white text; secondary buttons are neutral outlines; icon buttons share hover/focus geometry and accessible names. Delete remains a separately labeled danger action.

Dialogs use native `dialog`, accessible headings, Escape dismissal, focus containment, and restoration. Settings save preserves entered data on failure and returns to the task list on success. No browser alerts or confirmation popups. The existing shared toast handles transient feedback; inline form messages handle correctable errors.

## Motion

Locally bundled GSAP/ScrollTrigger provides a brief staggered dialog entrance and a restrained content/thumbnail reveal inside the existing task scroller. Images respond to row hover without moving the text. Controls and task actions remain visible and usable while animating. No pinned marketing sections, marquees, or artificial delays. Reduced motion skips GSAP motion and collapses CSS transitions.

## Content

Use concise Chinese labels and task-specific instructions. Original post text, author, date, URL, and filenames are untrusted text: escape before rendering. Show short captions directly; use an explicit expandable body for longer posts. Preserve full source addresses in links and tooltips. Do not add invented metadata.

## Verification

The mobile-access dialog uses the canonical native select for active IPv4 addresses. Default to the physical adapter chosen by routing, then other physical LAN addresses; offer Tailscale separately. Exclude host-only VM, container, loopback and link-local adapters. QR graphics are isolated SVG images with a four-module quiet zone, six CSS pixels per module and no inherited icon strokes or rounded line caps. Address selection updates the image, copy target, browser link and network-specific instructions together.

Run the project test suite and native release UI smoke. Inspect list, settings, create, QR, and confirmation surfaces at 1280x860 and 900x640, plus the companion layout at 390px. Exercise select keyboard interaction, switch save/cancel, long paths, empty/failed tasks, focus return, and reduced motion. Release packaging must preserve runtime state and verify restored hashes.
