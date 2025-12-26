import { useState, useEffect } from 'react'
import { Folder } from 'lucide-react'
import { getMeta } from '../db/database'
import { ITEM_CATEGORIES, CategoryConfig } from '../models/types'

interface CategorySelectProps {
  value?: string
  onChange: (category: string | undefined) => void
}

export function CategorySelect({ value, onChange }: CategorySelectProps) {
  const [categories, setCategories] = useState<CategoryConfig[]>(ITEM_CATEGORIES)

  // Load categories from database (custom categories override defaults)
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
              ...(value === cat.id ? {
                ...styles.optionSelected,
                backgroundColor: cat.color ? `${cat.color}33` : '#3d5a80',
                borderColor: cat.color || '#5d7aa0',
              } : {}),
            }}
            onClick={() => onChange(value === cat.id ? undefined : cat.id)}
          >
            {cat.color && (
              <span style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                backgroundColor: cat.color,
                marginRight: 6,
              }} />
            )}
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
