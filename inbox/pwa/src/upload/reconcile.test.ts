import { describe, expect, it } from 'vitest'
import { daysLeft, reconcile } from './reconcile'
import { mergeOutbox, type OutboxEntry } from '../store/db'
import type { RemoteOutbox } from '../api/client'

const base = (status: OutboxEntry['status'], extra: Partial<OutboxEntry> = {}): OutboxEntry => ({
  memoryId: 'm1',
  title: 't',
  startAt: '2026-09-01',
  mediaCount: 0,
  createdAt: '2026-09-01T10:00:00.000Z',
  status,
  ...extra,
})
const remote = (status: RemoteOutbox['status'], extra: Partial<RemoteOutbox> = {}): RemoteOutbox => ({
  memoryId: 'm1',
  status,
  createdAt: '2026-09-01T10:00:00.000Z',
  ...extra,
})

describe('reconcile', () => {
  it('ready lokaal, onbekend op de server → gone', () => {
    expect(reconcile(base('ready'), undefined, false)).toEqual({ status: 'gone' })
  })
  it('uploading zonder lopende upload en onbekend → failed', () => {
    expect(reconcile(base('uploading'), undefined, false)).toEqual({ status: 'failed' })
  })
  it('lopende upload wordt nooit aangeraakt', () => {
    expect(reconcile(base('uploading'), undefined, true)).toBeNull()
    expect(reconcile(base('uploading'), remote('uploading'), true)).toBeNull()
  })
  it('imported blijft imported als de tombstone al is opgeruimd', () => {
    expect(reconcile(base('imported'), undefined, false)).toBeNull()
  })
  it('server imported → imported', () => {
    expect(reconcile(base('ready'), remote('imported'), false)).toEqual({ status: 'imported' })
    expect(reconcile(base('gone'), remote('imported'), false)).toEqual({ status: 'imported' })
  })
  it('server ready → ready + verloopdatum overnemen', () => {
    const r = { readyAt: '2026-09-01T10:05:00.000Z', expiresAt: '2026-10-01T10:05:00.000Z' }
    expect(reconcile(base('failed'), remote('ready', r), false)).toEqual({
      status: 'ready',
      readyAt: '2026-09-01T10:05:00.000Z',
      expiresAt: '2026-10-01T10:05:00.000Z',
    })
    expect(reconcile(base('ready', r), remote('ready', r), false)).toBeNull()
  })
  it('oudere Worker zonder verloopvelden → alleen status', () => {
    expect(reconcile(base('uploading'), remote('ready'), false)).toEqual({ status: 'ready' })
  })
  it('server uploading zonder lopende upload → failed (onderbroken)', () => {
    expect(reconcile(base('uploading'), remote('uploading'), false)).toEqual({ status: 'failed' })
    expect(reconcile(base('failed'), remote('uploading'), false)).toBeNull()
  })
})

describe('daysLeft', () => {
  const now = Date.parse('2026-09-28T12:00:00.000Z')
  it('gebruikt expiresAt van de server', () => {
    expect(daysLeft(base('ready', { expiresAt: '2026-10-01T12:00:00.000Z' }), now)).toBe(3)
  })
  it('schat anders vanaf readyAt of createdAt + 30 dagen', () => {
    expect(daysLeft(base('ready', { readyAt: '2026-09-20T12:00:00.000Z' }), now)).toBe(22)
    expect(daysLeft(base('ready', { createdAt: '2026-08-01T12:00:00.000Z' }), now)).toBeLessThanOrEqual(0)
  })
})

describe('mergeOutbox', () => {
  const draft = { id: 'd1', title: 't', startAt: '2026-09-01', note: 'verhaal', media: [], createdAt: 'x', updatedAt: 'x' }
  it('statuswijziging laat snapshot en thumbs staan', () => {
    const cur = base('uploading', { draft, thumbs: {} })
    for (const status of ['ready', 'failed', 'gone', 'imported'] as const) {
      const next = mergeOutbox(cur, { status })
      expect(next.status).toBe(status)
      expect(next.draft).toBe(draft)
      expect(next.thumbs).toEqual({})
    }
  })
  it('undefined wist een veld; memoryId is niet te overschrijven', () => {
    const next = mergeOutbox(base('ready', { edit: draft }), { edit: undefined, memoryId: 'x' })
    expect('edit' in next).toBe(false)
    expect(next.memoryId).toBe('m1')
  })
})
