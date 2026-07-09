// L2 — Event-canvas: de items van één gebeurtenis als vrij, sleepbaar canvas.
// Foto's als kaartjes met witte rand, tekst als kaart. Posities komen uit
// `_canvas.json` (indien aanwezig) of een auto-grid. Slepen persisteert via
// de backend (write-through naar `_canvas.json`).

import { Container, Graphics, Sprite, Text, Texture } from 'pixi.js'
import type { Backend, CanvasLayoutInput, EventDetail, Item } from '../../lib/backend'
import type { FrameContext, RenderEngine } from '../core/engine'
import type { DragHandle } from '../core/gestures'
import type { Scene } from './scene'

const PHOTO = 200
const BORDER = 8
const TEXT_W = 240
const TEXT_H = 150
const CELL = 260

interface Node {
  item: Item
  ref: string
  container: Container
  sprite: Sprite | null
  x: number
  y: number
  half: number
  z: number
  key: string
  loaded: boolean
  // Layout-eigenschappen uit `_canvas.json` die deze fase (nog) niet visueel
  // toegepast worden maar WEL behouden moeten blijven bij het terugschrijven —
  // anders wist de eerste drag bestaande curatie (schaal/rotatie/afmeting).
  scale: number
  rotation: number
  textScale?: number
  width?: number
  height?: number
}

export class EventScene implements Scene {
  readonly root = new Container()
  private nodes: Node[] = []
  private zTop = 0
  private hoveredId: string | null = null

  constructor(
    private engine: RenderEngine,
    private backend: Backend,
    detail: EventDetail,
    private onSave: (items: CanvasLayoutInput[]) => void,
  ) {
    const layout = new Map(detail.canvas.map((c) => [c.itemRef, c]))
    const cols = Math.max(1, Math.ceil(Math.sqrt(detail.items.length)))

    detail.items.forEach((item, i) => {
      const ref = item.slug ?? item.id
      const container = new Container()
      const isText = item.itemType === 'text' || item.itemType === 'link'
      const half = isText ? Math.max(TEXT_W, TEXT_H) / 2 : PHOTO / 2 + BORDER

      let sprite: Sprite | null = null
      if (isText) {
        this.buildTextCard(container, item)
      } else {
        sprite = this.buildPhotoCard(container)
      }

      // Positie: uit _canvas.json of auto-grid.
      const saved = layout.get(ref)
      const x = saved ? saved.x : (i % cols) * CELL - ((cols - 1) * CELL) / 2
      const y = saved ? saved.y : Math.floor(i / cols) * CELL
      const z = saved ? saved.zIndex : i
      container.position.set(x, y)
      container.zIndex = z
      this.zTop = Math.max(this.zTop, z)

      this.root.addChild(container)
      this.nodes.push({
        item,
        ref,
        container,
        sprite,
        x,
        y,
        half,
        z,
        key: `item-${item.id}`,
        loaded: false,
        scale: saved?.scale ?? 1,
        rotation: saved?.rotation ?? 0,
        textScale: saved?.textScale,
        width: saved?.width,
        height: saved?.height,
      })
    })

    this.root.sortableChildren = true
    engine.world.addChild(this.root)
    this.fitCamera(cols, Math.max(1, Math.ceil(detail.items.length / cols)))
  }

  private buildPhotoCard(container: Container): Sprite {
    const frame = new Graphics()
    frame
      .roundRect(-PHOTO / 2 - BORDER, -PHOTO / 2 - BORDER, PHOTO + BORDER * 2, PHOTO + BORDER * 2, 4)
      .fill(0xf5f5f0)
    container.addChild(frame)
    const mask = new Graphics()
    mask.rect(-PHOTO / 2, -PHOTO / 2, PHOTO, PHOTO).fill(0xffffff)
    const sprite = new Sprite(Texture.WHITE)
    sprite.anchor.set(0.5)
    sprite.setSize(PHOTO, PHOTO)
    sprite.tint = 0x2a3345
    container.addChild(sprite)
    container.addChild(mask)
    sprite.mask = mask
    return sprite
  }

  private buildTextCard(container: Container, item: Item): void {
    const bg = new Graphics()
    bg.roundRect(-TEXT_W / 2, -TEXT_H / 2, TEXT_W, TEXT_H, 10).fill(0xfffdf5).stroke({
      width: 1,
      color: 0xe0dccb,
    })
    container.addChild(bg)
    const text = new Text({
      text: item.bodyText || item.caption || '…',
      style: {
        fill: 0x2b2b2b,
        fontSize: 16,
        fontStyle: 'italic',
        fontFamily: 'Georgia, serif',
        wordWrap: true,
        wordWrapWidth: TEXT_W - 32,
        align: 'center',
      },
    })
    text.resolution = 2
    // Boven-uitgelijnd + geklipt op het kader: lange tekst loopt niet meer buiten
    // de kaart (de volledige tekst lees je op L3, waar de kaart meegroeit).
    text.anchor.set(0.5, 0)
    text.position.set(0, -TEXT_H / 2 + 14)
    container.addChild(text)
    const clip = new Graphics()
    clip.roundRect(-TEXT_W / 2, -TEXT_H / 2, TEXT_W, TEXT_H, 10).fill(0xffffff)
    container.addChild(clip)
    text.mask = clip
  }

  private fitCamera(cols: number, rows: number): void {
    const vp = this.engine.viewport()
    const w = cols * CELL
    const h = rows * CELL
    const zoom = Math.min(vp.width / (w + CELL), vp.height / (h + CELL))
    this.engine.jumpCamera(
      0,
      h / 2 - CELL / 2,
      Math.max(this.engine.camera.minZoom, Math.min(zoom, 1.2)),
    )
  }

  beginDrag(wx: number, wy: number): DragHandle | null {
    // Bovenste item onder het punt.
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i]
      if (Math.abs(wx - n.x) <= n.half && Math.abs(wy - n.y) <= n.half) {
        const offX = n.x - wx
        const offY = n.y - wy
        const startX = n.x
        const startY = n.y
        // Naar voren halen.
        n.z = ++this.zTop
        n.container.zIndex = n.z
        let moved = false
        return {
          moveTo: (mx, my) => {
            n.x = mx + offX
            n.y = my + offY
            n.container.position.set(n.x, n.y)
            // Pas als echt verplaatst telt het als een drag → write. De drempel
            // is zoom-geschaald zodat hij overeenkomt met de 6px-scherm-tapdrempel
            // in de gesture-controller (world = screen / zoom). Anders zou een tik
            // met lichte jitter bij uitgezoomd L2 zowel persist ALS onTap (→L3)
            // triggeren én het item ongewild verschuiven.
            const dragPx = 6 / this.engine.camera.zoom
            if (!moved && Math.hypot(n.x - startX, n.y - startY) > dragPx) moved = true
          },
          end: () => {
            if (moved) this.persist()
          },
        }
      }
    }
    return null
  }

  private persist(): void {
    // Behoud bestaande layout-eigenschappen (scale/rotation/textScale/width/
    // height) uit `_canvas.json`; drag wijzigt alleen positie en z-order.
    const items: CanvasLayoutInput[] = this.nodes.map((n) => ({
      itemRef: n.ref,
      x: n.x,
      y: n.y,
      scale: n.scale,
      rotation: n.rotation,
      zIndex: n.z,
      textScale: n.textScale,
      width: n.width,
      height: n.height,
    }))
    this.onSave(items)
  }

  onHover(worldX: number | null, worldY: number): void {
    this.hoveredId = worldX === null ? null : this.hitTest(worldX, worldY)
  }

  update(ctx: FrameContext): void {
    const { engine, frame } = ctx
    for (const n of this.nodes) {
      // Vloeiende hover-schaal.
      const target = n.item.id === this.hoveredId ? 1.05 : 1
      const s = n.container.scale.x + (target - n.container.scale.x) * 0.2
      n.container.scale.set(s)

      if (!n.sprite || n.loaded || !n.item.media) continue
      const tex = engine.textures.get(n.key, frame)
      if (tex) {
        n.sprite.texture = tex
        n.sprite.tint = 0xffffff
        const s = Math.max(PHOTO / tex.width, PHOTO / tex.height)
        n.sprite.setSize(tex.width * s, tex.height * s)
        n.loaded = true
      } else {
        const src = this.backend.thumb(n.item.id, 256)
        engine.textures.request({ key: n.key, url: src.url, hue: src.hue, size: 256 })
      }
    }
  }

  hitTest(worldX: number, worldY: number): string | null {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i]
      if (Math.abs(worldX - n.x) <= n.half && Math.abs(worldY - n.y) <= n.half) {
        return n.item.id
      }
    }
    return null
  }

  destroy(): void {
    this.root.destroy({ children: true })
  }
}
