# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
npm run dev          # Start web dev server (port 5199)
npm run tauri dev    # Start Tauri desktop app (with hot reload)
npm run build        # TypeScript check + production build
npm run tauri build  # Build desktop app installer
```

**BELANGRIJK:** Start dev servers altijd in de achtergrond met `run_in_background: true`. Anders loopt Claude vast omdat de server nooit eindigt.

## Project Overview

**MemoryLane** - A local-first desktop & mobile app for navigating personal memories through a zoomable timeline interface. The core principle is semantic zoom over time with canvas-based events.

## Technology Stack

- **Build:** Vite + React + TypeScript
- **Rendering:** PixiJS 8.x (WebGL canvas) - DOM only for overlays
- **Database:**
  - Browser dev: sql.js (loaded via CDN script tag)
  - Desktop: tauri-plugin-sql with SQLite
- **Desktop:** Tauri 2.x (Rust backend)

## Project Structure

```
src/
├── models/types.ts    # Data types (Event, Item, CanvasItem, ViewState)
├── db/database.ts     # SQLite schema and CRUD operations
├── timeline/          # PixiJS timeline rendering
├── components/        # React UI components (overlays, panels)
└── hooks/             # React hooks

src-tauri/
├── src/main.rs        # Tauri Rust backend entry point
├── Cargo.toml         # Rust dependencies
└── tauri.conf.json    # Tauri configuration
```

## Architecture

### Core Data Model

Everything is an **Event**. Events can contain other events and have a canvas for content:

```
Event (id, type, title, startAt, endAt, parentId, coverMediaId)
  └── Item (id, eventId, itemType, content, caption, people, place, happenedAt)
  └── CanvasItem (eventId, itemId, x, y, scale, rotation, zIndex)
```

Event types: `year`, `period`, `event`, `item`
Item types: `text`, `photo`, `video`, `link`

### Zoom Levels (Semantic Zoom)

| Level | View | Content |
|-------|------|---------|
| L0 | Lifeline | Years/decades, horizontal scroll |
| L1 | Year view | Highlights + periods |
| L2 | Event canvas | Free canvas with items |
| L3 | Item focus | Single item, full detail |

Zoom is continuous (pinch/scroll) - no page transitions.

### Performance Requirements

- 60fps pan/zoom (max 16ms per frame)
- Viewport virtualization
- Level-of-detail (LOD) rendering:
  - L0/L1: blocks + labels only
  - L2: thumbnails
  - L3: full content
- Media thumbnails: 64px, 256px, 1024px (lazy loaded by zoom level)

### Sync Architecture

- Local SQLite is authoritative
- Event-based sync to cloud (async)
- Conflict resolution: last-write-wins (MVP)
- Media upload in background
- Cloud is sync-only, not required for core UX

## Design Principles

- UI responds to scale changes automatically
- No breadcrumbs, page transitions, or back buttons per level
- Canvas layout stored separately from content (enables reuse)
- DOM only for overlays/edit panels, not main timeline
