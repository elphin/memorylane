import { useState, useEffect } from 'react'
import { Filter, Tag, Users } from 'lucide-react'
import { getMeta, getAllTags, getAllPeople } from '../../db/database'
import { ITEM_CATEGORIES, CategoryConfig, TimelineFilterSettings, DEFAULT_TIMELINE_FILTERS } from '../../models/types'

const STORAGE_KEY = 'timeline_filter_settings'

export function SettingsTimelineFilters() {
  const [categories, setCategories] = useState<CategoryConfig[]>(ITEM_CATEGORIES)
  const [settings, setSettings] = useState<TimelineFilterSettings>(DEFAULT_TIMELINE_FILTERS)
  const [availableTags, setAvailableTags] = useState<string[]>([])
  const [availablePeople, setAvailablePeople] = useState<string[]>([])

  // Load categories and settings
  useEffect(() => {
    // Load custom categories if set
    const savedCats = getMeta('custom_categories')
    if (savedCats) {
      try {
        const parsed = JSON.parse(savedCats)
        if (Array.isArray(parsed) && parsed.length > 0) {
          setCategories(parsed)
        }
      } catch {
        // Use defaults
      }
    }

    // Load filter settings
    const savedSettings = localStorage.getItem(STORAGE_KEY)
    if (savedSettings) {
      try {
        const parsed = JSON.parse(savedSettings)
        setSettings({ ...DEFAULT_TIMELINE_FILTERS, ...parsed })
      } catch {
        // Use defaults
      }
    }

    // Load available tags and people
    setAvailableTags(getAllTags())
    setAvailablePeople(getAllPeople())
  }, [])

  // Save settings
  const saveSettings = (newSettings: TimelineFilterSettings) => {
    setSettings(newSettings)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newSettings))
  }

  // Toggle category filter
  const toggleCategory = (catId: string) => {
    const current = settings.categories
    const newCategories = current.includes(catId)
      ? current.filter(c => c !== catId)
      : [...current, catId]
    saveSettings({ ...settings, categories: newCategories })
  }

  // Toggle tag filter
  const toggleTag = (tag: string) => {
    const current = settings.tags
    const newTags = current.includes(tag)
      ? current.filter(t => t !== tag)
      : [...current, tag]
    saveSettings({ ...settings, tags: newTags })
  }

  // Toggle person filter
  const togglePerson = (person: string) => {
    const current = settings.people
    const newPeople = current.includes(person)
      ? current.filter(p => p !== person)
      : [...current, person]
    saveSettings({ ...settings, people: newPeople })
  }

  // Toggle random fill
  const toggleRandomFill = () => {
    saveSettings({ ...settings, showRandomFill: !settings.showRandomFill })
  }

  // Update max random photos
  const updateMaxRandomPhotos = (value: number) => {
    saveSettings({ ...settings, maxRandomPhotos: value })
  }

  // Reset filters
  const resetFilters = () => {
    saveSettings(DEFAULT_TIMELINE_FILTERS)
  }

  return (
    <div style={styles.container}>
      <div style={styles.section}>
        <div style={styles.sectionHeader}>
          <Filter size={16} />
          <h3 style={styles.sectionTitle}>Categorieën</h3>
        </div>
        <p style={styles.hint}>
          Selecteer welke categorieën worden getoond op de jaar-timeline.
          Geen selectie = alles tonen.
        </p>
        <div style={styles.checkboxGrid}>
          {categories.map(cat => (
            <label key={cat.id} style={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={settings.categories.length === 0 || settings.categories.includes(cat.id)}
                onChange={() => toggleCategory(cat.id)}
                style={styles.checkbox}
              />
              <span
                style={{
                  ...styles.colorDot,
                  backgroundColor: cat.color || '#888',
                }}
              />
              <span>{cat.label}</span>
            </label>
          ))}
        </div>
      </div>

      {availableTags.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionHeader}>
            <Tag size={16} />
            <h3 style={styles.sectionTitle}>Tags</h3>
          </div>
          <p style={styles.hint}>
            Filter op specifieke tags. Geen selectie = alles tonen.
          </p>
          <div style={styles.tagCloud}>
            {availableTags.map(tag => (
              <button
                key={tag}
                style={{
                  ...styles.tagButton,
                  ...(settings.tags.includes(tag) ? styles.tagButtonSelected : {}),
                }}
                onClick={() => toggleTag(tag)}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>
      )}

      {availablePeople.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionHeader}>
            <Users size={16} />
            <h3 style={styles.sectionTitle}>Personen</h3>
          </div>
          <p style={styles.hint}>
            Filter op specifieke personen. Geen selectie = alles tonen.
          </p>
          <div style={styles.tagCloud}>
            {availablePeople.map(person => (
              <button
                key={person}
                style={{
                  ...styles.tagButton,
                  ...(settings.people.includes(person) ? styles.tagButtonSelected : {}),
                }}
                onClick={() => togglePerson(person)}
              >
                {person}
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>Random Foto's</h3>
        <label style={styles.switchLabel}>
          <span>Vul lege ruimtes met random foto's</span>
          <input
            type="checkbox"
            checked={settings.showRandomFill}
            onChange={toggleRandomFill}
            style={styles.switch}
          />
        </label>
        {settings.showRandomFill && (
          <div style={styles.sliderRow}>
            <span style={styles.sliderLabel}>Max aantal:</span>
            <input
              type="range"
              min={5}
              max={50}
              step={5}
              value={settings.maxRandomPhotos}
              onChange={(e) => updateMaxRandomPhotos(parseInt(e.target.value))}
              style={styles.slider}
            />
            <span style={styles.sliderValue}>{settings.maxRandomPhotos}</span>
          </div>
        )}
      </div>

      <div style={styles.section}>
        <button style={styles.resetButton} onClick={resetFilters}>
          Herstel standaardwaarden
        </button>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: 24,
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: '#888',
  },
  sectionTitle: {
    margin: 0,
    fontSize: 12,
    fontWeight: 600,
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  hint: {
    margin: 0,
    fontSize: 13,
    color: '#666',
    lineHeight: 1.5,
  },
  checkboxGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
    gap: 8,
  },
  checkboxLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    backgroundColor: '#252545',
    borderRadius: 6,
    fontSize: 13,
    color: '#ddd',
    cursor: 'pointer',
    transition: 'background-color 0.15s',
  },
  checkbox: {
    accentColor: '#64B5F6',
  },
  colorDot: {
    width: 10,
    height: 10,
    borderRadius: '50%',
  },
  tagCloud: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
  },
  tagButton: {
    padding: '6px 12px',
    backgroundColor: '#252545',
    border: '1px solid #333',
    borderRadius: 16,
    color: '#aaa',
    fontSize: 12,
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  },
  tagButtonSelected: {
    backgroundColor: '#3d5a80',
    borderColor: '#5d7aa0',
    color: '#fff',
  },
  switchLabel: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 14px',
    backgroundColor: '#252545',
    borderRadius: 8,
    fontSize: 14,
    color: '#ddd',
    cursor: 'pointer',
  },
  switch: {
    width: 40,
    height: 22,
    accentColor: '#64B5F6',
  },
  sliderRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '8px 14px',
    backgroundColor: '#1a1a2e',
    borderRadius: 6,
  },
  sliderLabel: {
    fontSize: 13,
    color: '#888',
  },
  slider: {
    flex: 1,
    accentColor: '#64B5F6',
  },
  sliderValue: {
    fontSize: 13,
    color: '#fff',
    fontWeight: 600,
    minWidth: 24,
    textAlign: 'right',
  },
  resetButton: {
    padding: '8px 12px',
    backgroundColor: 'transparent',
    border: 'none',
    borderRadius: 6,
    color: '#666',
    fontSize: 12,
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'color 0.2s',
  },
}
