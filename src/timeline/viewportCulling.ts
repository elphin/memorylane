// Viewport Culling System
// Only renders items that are visible in the current viewport

import { Container } from 'pixi.js'

export interface ItemBounds {
  id: string
  x: number
  y: number
  width: number
  height: number
  scale: number
}

export interface ViewportBounds {
  left: number
  right: number
  top: number
  bottom: number
}

// Margin around viewport to pre-load items before they become visible
const VIEWPORT_MARGIN = 200

/**
 * Calculate viewport bounds from container position, scale, and screen size
 */
export function calculateViewportBounds(
  containerX: number,
  containerY: number,
  containerScale: number,
  screenWidth: number,
  screenHeight: number
): ViewportBounds {
  // Convert screen coordinates to content coordinates
  // Container is at (containerX, containerY) and scaled
  // Screen center is at (screenWidth/2, screenHeight/2)

  const halfWidth = (screenWidth / 2) / containerScale
  const halfHeight = (screenHeight / 2) / containerScale

  // Content coordinate at screen center
  const centerX = (screenWidth / 2 - containerX) / containerScale
  const centerY = (screenHeight / 2 - containerY) / containerScale

  return {
    left: centerX - halfWidth - VIEWPORT_MARGIN,
    right: centerX + halfWidth + VIEWPORT_MARGIN,
    top: centerY - halfHeight - VIEWPORT_MARGIN,
    bottom: centerY + halfHeight + VIEWPORT_MARGIN,
  }
}

/**
 * Check if an item intersects with the viewport
 */
export function isItemInViewport(item: ItemBounds, viewport: ViewportBounds): boolean {
  const itemLeft = item.x - (item.width * item.scale) / 2
  const itemRight = item.x + (item.width * item.scale) / 2
  const itemTop = item.y - (item.height * item.scale) / 2
  const itemBottom = item.y + (item.height * item.scale) / 2

  return !(
    itemRight < viewport.left ||
    itemLeft > viewport.right ||
    itemBottom < viewport.top ||
    itemTop > viewport.bottom
  )
}

/**
 * Get list of visible item IDs
 */
export function getVisibleItems(items: ItemBounds[], viewport: ViewportBounds): Set<string> {
  const visible = new Set<string>()

  for (const item of items) {
    if (isItemInViewport(item, viewport)) {
      visible.add(item.id)
    }
  }

  return visible
}

/**
 * Viewport Culling Manager
 * Tracks which items are currently rendered and handles add/remove
 */
export class ViewportCullingManager {
  private items: Map<string, ItemBounds> = new Map()
  private renderedItems: Map<string, Container> = new Map()
  private container: Container
  private createItemBlock: (id: string) => Container | null
  private lastViewport: ViewportBounds | null = null

  constructor(
    container: Container,
    createItemBlock: (id: string) => Container | null
  ) {
    this.container = container
    this.createItemBlock = createItemBlock
  }

  /**
   * Register an item's bounds (call this for all items in the event)
   */
  registerItem(bounds: ItemBounds): void {
    this.items.set(bounds.id, bounds)
  }

  /**
   * Clear all registered items
   */
  clearItems(): void {
    // Remove all rendered items
    for (const [, block] of this.renderedItems) {
      this.container.removeChild(block)
      block.destroy({ children: true })
    }
    this.renderedItems.clear()
    this.items.clear()
    this.lastViewport = null
  }

  /**
   * Update which items are rendered based on viewport
   * Call this on each frame or when viewport changes
   */
  update(viewport: ViewportBounds): void {
    // Get currently visible items
    const visibleIds = getVisibleItems(Array.from(this.items.values()), viewport)

    // Remove items that are no longer visible
    for (const [id, block] of this.renderedItems) {
      if (!visibleIds.has(id)) {
        this.container.removeChild(block)
        block.destroy({ children: true })
        this.renderedItems.delete(id)
      }
    }

    // Add items that are now visible but not yet rendered
    for (const id of visibleIds) {
      if (!this.renderedItems.has(id)) {
        const block = this.createItemBlock(id)
        if (block) {
          const bounds = this.items.get(id)!
          block.x = bounds.x
          block.y = bounds.y
          block.scale.set(bounds.scale)
          this.container.addChild(block)
          this.renderedItems.set(id, block)
        }
      }
    }

    this.lastViewport = viewport
  }

  /**
   * Get count of rendered items (for debugging)
   */
  getRenderedCount(): number {
    return this.renderedItems.size
  }

  /**
   * Get total item count (for debugging)
   */
  getTotalCount(): number {
    return this.items.size
  }

  /**
   * Force re-render an item (e.g., after position change)
   */
  updateItemPosition(id: string, x: number, y: number, scale: number): void {
    const bounds = this.items.get(id)
    if (bounds) {
      bounds.x = x
      bounds.y = y
      bounds.scale = scale
    }

    const block = this.renderedItems.get(id)
    if (block) {
      block.x = x
      block.y = y
      block.scale.set(scale)
    }
  }

  /**
   * Remove a specific item
   */
  removeItem(id: string): void {
    this.items.delete(id)

    const block = this.renderedItems.get(id)
    if (block) {
      this.container.removeChild(block)
      block.destroy({ children: true })
      this.renderedItems.delete(id)
    }
  }

  /**
   * Check if viewport changed significantly
   */
  hasViewportChanged(viewport: ViewportBounds): boolean {
    if (!this.lastViewport) return true

    const threshold = 50 // pixels
    return (
      Math.abs(viewport.left - this.lastViewport.left) > threshold ||
      Math.abs(viewport.right - this.lastViewport.right) > threshold ||
      Math.abs(viewport.top - this.lastViewport.top) > threshold ||
      Math.abs(viewport.bottom - this.lastViewport.bottom) > threshold
    )
  }
}
