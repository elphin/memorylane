import { useState, useEffect, useCallback } from 'react'
import { motion } from 'motion/react'
import { Item } from '../models/types'
import { getMeta } from '../db/database'
import {
  X, Edit, Trash2, Calendar, MapPin, Users, Tag, Folder, Check, ChevronLeft, ChevronRight, Link as LinkIcon, ExternalLink
} from 'lucide-react'
import { TagInput } from './TagInput'

interface LinkViewerProps {
  item: Item
  allItems: Item[]
  eventTitle: string
  eventStartDate?: string
  onClose: () => void
  onDelete: (item: Item) => void
  onSave: (item: Item, updates: { content?: string; caption?: string; happenedAt?: string; place?: Item['place']; people?: string[]; tags?: string[]; category?: string }) => void
  onNavigate: (item: Item) => void
}

export function LinkViewer({
  item,
  allItems,
  eventTitle,
  eventStartDate,
  onClose,
  onDelete,
  onSave,
  onNavigate,
}: LinkViewerProps) {
  const getDefaultDate = (itm: Item) => {
    if (itm.happenedAt) return itm.happenedAt.split('T')[0]
    if (eventStartDate) return eventStartDate.split('T')[0]
    return ''
  }

  const [isEditing, setIsEditing] = useState(false)
  const [editUrl, setEditUrl] = useState(item.content || '')
  const [editCaption, setEditCaption] = useState(item.caption || '')
  const [editDate, setEditDate] = useState(getDefaultDate(item))
  const [editTime, setEditTime] = useState(item.happenedAt?.split('T')[1]?.substring(0, 5) || '')
  const [editLocationLabel, setEditLocationLabel] = useState(item.place?.label || '')
  const [editPeople, setEditPeople] = useState(item.people?.join(', ') || '')
  const [editTags, setEditTags] = useState<string[]>(item.tags || [])
  const [editCategory, setEditCategory] = useState<string | undefined>(item.category)

  const [categories, setCategories] = useState<{ id: string; label: string }[]>([
    { id: 'persoonlijk', label: 'Persoonlijk' },
    { id: 'werk', label: 'Werk' },
    { id: 'familie', label: 'Familie' },
    { id: 'creatief', label: 'Creatief' },
    { id: 'vakantie', label: 'Vakantie' },
  ])

  useEffect(() => {
    const saved = getMeta('custom_categories')
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed) && parsed.length > 0) {
          setCategories(parsed)
        }
      } catch {
        // Use defaults
      }
    }
  }, [])

  const linkItems = allItems.filter(i => i.itemType === 'link')
  const currentIndex = linkItems.findIndex(i => i.id === item.id)
  const hasPrev = currentIndex > 0
  const hasNext = currentIndex < linkItems.length - 1

  useEffect(() => {
    setEditUrl(item.content || '')
    setEditCaption(item.caption || '')
    setEditDate(getDefaultDate(item))
    setEditTime(item.happenedAt?.split('T')[1]?.substring(0, 5) || '')
    setEditLocationLabel(item.place?.label || '')
    setEditPeople(item.people?.join(', ') || '')
    setEditTags(item.tags || [])
    setEditCategory(item.category)
    setIsEditing(false)
  }, [item, eventStartDate])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isEditing) return

      switch (e.key) {
        case 'Escape':
          onClose()
          break
        case 'ArrowLeft':
          if (hasPrev) onNavigate(linkItems[currentIndex - 1])
          break
        case 'ArrowRight':
          if (hasNext) onNavigate(linkItems[currentIndex + 1])
          break
        case 'e':
          setIsEditing(true)
          break
        case 'Enter':
          window.open(item.content, '_blank', 'noopener,noreferrer')
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, hasPrev, hasNext, linkItems, currentIndex, onNavigate, isEditing, item.content])

  const handleSave = useCallback(() => {
    const peopleArray = editPeople.split(',').map(p => p.trim()).filter(Boolean)
    const happenedAt = editDate ? `${editDate}${editTime ? `T${editTime}:00` : ''}` : undefined

    onSave(item, {
      content: editUrl,
      caption: editCaption || undefined,
      happenedAt,
      place: editLocationLabel ? { lat: 0, lng: 0, label: editLocationLabel } : undefined,
      people: peopleArray.length > 0 ? peopleArray : undefined,
      tags: editTags.length > 0 ? editTags : undefined,
      category: editCategory,
    })
    setIsEditing(false)
  }, [item, editUrl, editCaption, editDate, editTime, editLocationLabel, editPeople, editTags, editCategory, onSave])

  const handleDelete = useCallback(() => {
    if (confirm('Weet je zeker dat je deze link wilt verwijderen?')) {
      onDelete(item)
    }
  }, [item, onDelete])

  const handleOpenLink = useCallback(() => {
    window.open(item.content, '_blank', 'noopener,noreferrer')
  }, [item.content])

  const formatDate = (dateStr: string) => {
    try {
      const date = new Date(dateStr)
      return date.toLocaleDateString('nl-NL', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    } catch {
      return dateStr
    }
  }

  const getCategoryLabel = (id: string) => {
    return categories.find(c => c.id === id)?.label || id
  }

  const getDomain = (url: string) => {
    try {
      const urlObj = new URL(url)
      return urlObj.hostname
    } catch {
      return url
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      style={styles.overlay}
      onClick={onClose}
    >
      <button style={styles.closeButton} onClick={onClose} title="Sluiten (Esc)">
        <X size={24} />
      </button>

      {hasPrev && (
        <button
          style={{ ...styles.navButton, left: 20 }}
          onClick={(e) => { e.stopPropagation(); onNavigate(linkItems[currentIndex - 1]) }}
          title="Vorige (←)"
        >
          <ChevronLeft size={32} />
        </button>
      )}
      {hasNext && (
        <button
          style={{ ...styles.navButton, right: 20 }}
          onClick={(e) => { e.stopPropagation(); onNavigate(linkItems[currentIndex + 1]) }}
          title="Volgende (→)"
        >
          <ChevronRight size={32} />
        </button>
      )}

      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        transition={{ type: 'spring', damping: 25 }}
        style={styles.card}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={styles.header}>
          <div style={styles.headerInfo}>
            <span style={styles.eventTitle}>{eventTitle}</span>
            {linkItems.length > 1 && (
              <span style={styles.counter}>{currentIndex + 1} / {linkItems.length}</span>
            )}
          </div>
          <div style={styles.headerActions}>
            {isEditing ? (
              <button style={styles.actionButton} onClick={handleSave} title="Opslaan">
                <Check size={20} />
              </button>
            ) : (
              <button style={styles.actionButton} onClick={() => setIsEditing(true)} title="Bewerken (E)">
                <Edit size={20} />
              </button>
            )}
            <button style={{ ...styles.actionButton, ...styles.deleteButton }} onClick={handleDelete} title="Verwijderen">
              <Trash2 size={20} />
            </button>
          </div>
        </div>

        <div style={styles.content}>
          {isEditing ? (
            <div style={styles.editUrlContainer}>
              <label style={styles.label}>URL</label>
              <input
                type="url"
                value={editUrl}
                onChange={(e) => setEditUrl(e.target.value)}
                style={styles.urlInput}
                placeholder="https://..."
                autoFocus
              />
            </div>
          ) : (
            <div style={styles.linkContainer}>
              <div style={styles.linkIcon}>
                <LinkIcon size={48} color="#2196F3" />
              </div>
              <div style={styles.linkInfo}>
                <span style={styles.domain}>{getDomain(item.content)}</span>
                <a
                  href={item.content}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={styles.url}
                  onClick={(e) => e.stopPropagation()}
                >
                  {item.content}
                </a>
              </div>
              <button style={styles.openButton} onClick={handleOpenLink} title="Open in nieuw tabblad (Enter)">
                <ExternalLink size={20} />
                <span>Openen</span>
              </button>
            </div>
          )}
        </div>

        <div style={styles.metadata}>
          {isEditing ? (
            <div style={styles.editForm}>
              <div style={styles.formRow}>
                <label style={styles.label}>Beschrijving</label>
                <input
                  type="text"
                  value={editCaption}
                  onChange={(e) => setEditCaption(e.target.value)}
                  style={styles.input}
                  placeholder="Beschrijving van de link..."
                />
              </div>

              <div style={styles.formRow}>
                <label style={styles.label}><Calendar size={14} style={{ marginRight: 6 }} />Datum</label>
                <div style={styles.dateTimeRow}>
                  <input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} style={{ ...styles.input, flex: 1 }} />
                  <input type="time" value={editTime} onChange={(e) => setEditTime(e.target.value)} style={{ ...styles.input, width: 100 }} />
                </div>
              </div>

              <div style={styles.formRow}>
                <label style={styles.label}><MapPin size={14} style={{ marginRight: 6 }} />Locatie</label>
                <input type="text" value={editLocationLabel} onChange={(e) => setEditLocationLabel(e.target.value)} style={styles.input} placeholder="Plaats of locatie..." />
              </div>

              <div style={styles.formRow}>
                <label style={styles.label}><Users size={14} style={{ marginRight: 6 }} />Personen</label>
                <input type="text" value={editPeople} onChange={(e) => setEditPeople(e.target.value)} style={styles.input} placeholder="Namen, gescheiden door komma's..." />
              </div>

              <div style={styles.formRow}>
                <label style={styles.label}><Tag size={14} style={{ marginRight: 6 }} />Tags</label>
                <TagInput tags={editTags} onChange={setEditTags} placeholder="Voeg tags toe..." />
              </div>

              <div style={styles.formRow}>
                <label style={styles.label}><Folder size={14} style={{ marginRight: 6 }} />Categorie</label>
                <select value={editCategory || ''} onChange={(e) => setEditCategory(e.target.value || undefined)} style={styles.select}>
                  <option value="">Geen categorie</option>
                  {categories.map(cat => <option key={cat.id} value={cat.id}>{cat.label}</option>)}
                </select>
              </div>
            </div>
          ) : (
            <div style={styles.metadataView}>
              {item.caption && <p style={styles.caption}>{item.caption}</p>}

              <div style={styles.metadataGrid}>
                {(item.happenedAt || eventStartDate) && (
                  <div style={styles.metadataItem}>
                    <Calendar size={14} />
                    <span>{formatDate(item.happenedAt || eventStartDate!)}</span>
                  </div>
                )}
                {item.place?.label && (
                  <div style={styles.metadataItem}>
                    <MapPin size={14} />
                    <span>{item.place.label}</span>
                  </div>
                )}
                {item.people && item.people.length > 0 && (
                  <div style={styles.metadataItem}>
                    <Users size={14} />
                    <span>{item.people.join(', ')}</span>
                  </div>
                )}
                {item.category && (
                  <div style={styles.metadataItem}>
                    <Folder size={14} />
                    <span style={styles.categoryBadge}>{getCategoryLabel(item.category)}</span>
                  </div>
                )}
              </div>

              {item.tags && item.tags.length > 0 && (
                <div style={styles.tagsRow}>
                  <Tag size={14} />
                  <div style={styles.tagsList}>
                    {item.tags.map(tag => <span key={tag} style={styles.tag}>{tag}</span>)}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}

const styles: { [key: string]: React.CSSProperties } = {
  overlay: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.9)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    padding: 40,
  },
  closeButton: {
    position: 'absolute',
    top: 20,
    right: 20,
    background: 'rgba(255, 255, 255, 0.1)',
    border: 'none',
    borderRadius: 8,
    padding: 8,
    color: 'white',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  navButton: {
    position: 'absolute',
    top: '50%',
    transform: 'translateY(-50%)',
    background: 'rgba(255, 255, 255, 0.1)',
    border: 'none',
    borderRadius: 12,
    padding: '16px 8px',
    color: 'white',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  card: {
    backgroundColor: '#1a1a2e',
    borderRadius: 16,
    maxWidth: 550,
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 20px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
  },
  headerInfo: { display: 'flex', alignItems: 'center', gap: 12 },
  eventTitle: { color: 'rgba(255, 255, 255, 0.7)', fontSize: 14 },
  counter: { color: 'rgba(255, 255, 255, 0.5)', fontSize: 13, padding: '2px 8px', backgroundColor: 'rgba(255, 255, 255, 0.1)', borderRadius: 12 },
  headerActions: { display: 'flex', gap: 8 },
  actionButton: { background: 'rgba(255, 255, 255, 0.1)', border: 'none', borderRadius: 8, padding: 8, color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  deleteButton: { color: '#ff6b6b' },
  content: { padding: 24 },
  linkContainer: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: 16 },
  linkIcon: { width: 80, height: 80, borderRadius: '50%', backgroundColor: 'rgba(33, 150, 243, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  linkInfo: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, textAlign: 'center' },
  domain: { color: 'rgba(255, 255, 255, 0.5)', fontSize: 13, textTransform: 'uppercase', letterSpacing: 1 },
  url: { color: '#2196F3', fontSize: 14, wordBreak: 'break-all', textDecoration: 'none' },
  openButton: { display: 'flex', alignItems: 'center', gap: 8, backgroundColor: '#2196F3', color: 'white', border: 'none', borderRadius: 8, padding: '10px 20px', cursor: 'pointer', fontSize: 14, fontWeight: 500, marginTop: 8 },
  editUrlContainer: { display: 'flex', flexDirection: 'column', gap: 8 },
  urlInput: { backgroundColor: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.2)', borderRadius: 6, padding: '12px 16px', color: 'white', fontSize: 16 },
  metadata: { borderTop: '1px solid rgba(255, 255, 255, 0.1)', padding: 20, backgroundColor: 'rgba(0, 0, 0, 0.2)' },
  metadataView: { display: 'flex', flexDirection: 'column', gap: 12 },
  caption: { color: 'rgba(255, 255, 255, 0.8)', fontSize: 15, fontStyle: 'italic', margin: 0, marginBottom: 8 },
  metadataGrid: { display: 'flex', flexWrap: 'wrap', gap: '8px 20px' },
  metadataItem: { display: 'flex', alignItems: 'center', gap: 8, color: 'rgba(255, 255, 255, 0.6)', fontSize: 14 },
  tagsRow: { display: 'flex', alignItems: 'flex-start', gap: 8, color: 'rgba(255, 255, 255, 0.6)', marginTop: 4 },
  tagsList: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  tag: { backgroundColor: 'rgba(93, 122, 160, 0.3)', color: '#8ab4f8', padding: '2px 10px', borderRadius: 12, fontSize: 13 },
  categoryBadge: { backgroundColor: 'rgba(147, 112, 219, 0.2)', color: '#b39ddb', padding: '2px 10px', borderRadius: 12, fontSize: 13 },
  editForm: { display: 'flex', flexDirection: 'column', gap: 16 },
  formRow: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { color: 'rgba(255, 255, 255, 0.6)', fontSize: 13, display: 'flex', alignItems: 'center' },
  input: { backgroundColor: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.2)', borderRadius: 6, padding: '8px 12px', color: 'white', fontSize: 14 },
  dateTimeRow: { display: 'flex', gap: 8 },
  select: { backgroundColor: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.2)', borderRadius: 6, padding: '8px 12px', color: 'white', fontSize: 14 },
}
