import { useState, useEffect } from 'react'
import { Folder } from 'lucide-react'
import { getMeta } from '../db/database'

// Default categories (fallback if no custom categories saved)
const DEFAULT_CATEGORIES = [
  { id: 'persoonlijk', label: 'Persoonlijk' },
  { id: 'werk', label: 'Werk' },
  { id: 'familie', label: 'Familie' },
  { id: 'creatief', label: 'Creatief' },
  { id: 'vakantie', label: 'Vakantie' },
]

interface CategoryConfig {
  id: string
  label: string
}

interface CategorySelectProps {
  value?: string
  onChange: (category: string | undefined) => void
}

export function CategorySelect({ value, onChange }: CategorySelectProps) {
  const [categories, setCategories] = useState<CategoryConfig[]>(DEFAULT_CATEGORIES)

  // Load categories from database
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

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <Folder size={14} />
        <span>Categorie</span>
      </div>
      <div style={styles.options}>
        {categories.map((cat) => (
          <button
            key={cat.id}
            type="button"
            style={{
              ...styles.option,
              ...(value === cat.id ? styles.optionSelected : {}),
            }}
            onClick={() => onChange(value === cat.id ? undefined : cat.id)}
          >
            {cat.label}
          </button>
        ))}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    color: '#888',
    fontSize: 12,
    fontWeight: 500,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  options: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
  },
  option: {
    padding: '6px 12px',
    backgroundColor: '#252545',
    border: '1px solid #333',
    borderRadius: 16,
    color: '#aaa',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  },
  optionSelected: {
    backgroundColor: '#3d5a80',
    borderColor: '#5d7aa0',
    color: '#fff',
  },
}
