import { useState, useEffect } from 'react'
import { Plus, Pencil, Trash2, Check, X } from 'lucide-react'
import { getMeta, setMeta } from '../../db/database'
import { ITEM_CATEGORIES, CategoryConfig } from '../../models/types'

// Preset colors for easy selection
const PRESET_COLORS = [
  '#64B5F6', // Blue
  '#81C784', // Green
  '#FFB74D', // Orange
  '#BA68C8', // Purple
  '#4DD0E1', // Cyan
  '#F06292', // Pink
  '#FFD54F', // Yellow
  '#A1887F', // Brown
  '#90A4AE', // Gray
  '#FF8A65', // Deep Orange
]

export function SettingsCategories() {
  const [categories, setCategories] = useState<CategoryConfig[]>(ITEM_CATEGORIES)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingLabel, setEditingLabel] = useState('')
  const [editingColor, setEditingColor] = useState('')
  const [isAdding, setIsAdding] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newColor, setNewColor] = useState(PRESET_COLORS[0])

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

  // Save categories to database
  const saveCategories = (cats: CategoryConfig[]) => {
    setCategories(cats)
    setMeta('custom_categories', JSON.stringify(cats))
  }

  // Start editing
  const handleEdit = (cat: CategoryConfig) => {
    setEditingId(cat.id)
    setEditingLabel(cat.label)
    setEditingColor(cat.color || PRESET_COLORS[0])
  }

  // Save edit
  const handleSaveEdit = () => {
    if (!editingId || !editingLabel.trim()) return
    const updated = categories.map(cat =>
      cat.id === editingId ? { ...cat, label: editingLabel.trim(), color: editingColor } : cat
    )
    saveCategories(updated)
    setEditingId(null)
    setEditingLabel('')
    setEditingColor('')
  }

  // Cancel edit
  const handleCancelEdit = () => {
    setEditingId(null)
    setEditingLabel('')
    setEditingColor('')
  }

  // Update color only (without full edit mode)
  const handleColorChange = (catId: string, color: string) => {
    const updated = categories.map(cat =>
      cat.id === catId ? { ...cat, color } : cat
    )
    saveCategories(updated)
  }

  // Delete category
  const handleDelete = (id: string) => {
    if (categories.length <= 1) return // Keep at least one
    const updated = categories.filter(cat => cat.id !== id)
    saveCategories(updated)
  }

  // Add new category
  const handleAdd = () => {
    if (!newLabel.trim()) return
    const id = newLabel.trim().toLowerCase().replace(/\s+/g, '-')
    // Check for duplicate id
    if (categories.some(cat => cat.id === id)) {
      return
    }
    const updated = [...categories, { id, label: newLabel.trim(), color: newColor }]
    saveCategories(updated)
    setNewLabel('')
    setNewColor(PRESET_COLORS[0])
    setIsAdding(false)
  }

  // Reset to defaults
  const handleReset = () => {
    saveCategories(ITEM_CATEGORIES)
  }

  return (
    <div style={styles.container}>
      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>Item Categorieën</h3>
        <p style={styles.hint}>
          Categorieën helpen je herinneringen te organiseren. Klik om te bewerken.
        </p>

        <div style={styles.categoryList}>
          {categories.map((cat) => (
            <div key={cat.id} style={styles.categoryItem}>
              {editingId === cat.id ? (
                // Edit mode
                <div style={styles.editContainer}>
                  <div style={styles.editRow}>
                    <input
                      type="text"
                      value={editingLabel}
                      onChange={(e) => setEditingLabel(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveEdit()
                        if (e.key === 'Escape') handleCancelEdit()
                      }}
                      style={styles.editInput}
                      autoFocus
                    />
                    <button style={styles.iconButton} onClick={handleSaveEdit}>
                      <Check size={16} color="#4ade80" />
                    </button>
                    <button style={styles.iconButton} onClick={handleCancelEdit}>
                      <X size={16} color="#888" />
                    </button>
                  </div>
                  <div style={styles.colorPicker}>
                    {PRESET_COLORS.map(color => (
                      <button
                        key={color}
                        style={{
                          ...styles.colorSwatch,
                          backgroundColor: color,
                          ...(editingColor === color ? styles.colorSwatchSelected : {}),
                        }}
                        onClick={() => setEditingColor(color)}
                      />
                    ))}
                  </div>
                </div>
              ) : (
                // View mode
                <div style={styles.viewRow}>
                  <div style={styles.labelWithColor}>
                    <div style={styles.colorDot} >
                      <input
                        type="color"
                        value={cat.color || PRESET_COLORS[0]}
                        onChange={(e) => handleColorChange(cat.id, e.target.value)}
                        style={styles.colorInput}
                        title="Klik om kleur te wijzigen"
                      />
                      <span style={{ ...styles.colorDotInner, backgroundColor: cat.color || PRESET_COLORS[0] }} />
                    </div>
                    <span style={styles.categoryLabel}>{cat.label}</span>
                  </div>
                  <div style={styles.actions}>
                    <button style={styles.iconButton} onClick={() => handleEdit(cat)}>
                      <Pencil size={14} />
                    </button>
                    <button
                      style={styles.iconButton}
                      onClick={() => handleDelete(cat.id)}
                      disabled={categories.length <= 1}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* Add new */}
          {isAdding ? (
            <div style={styles.categoryItem}>
              <div style={styles.editContainer}>
                <div style={styles.editRow}>
                  <input
                    type="text"
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAdd()
                      if (e.key === 'Escape') {
                        setIsAdding(false)
                        setNewLabel('')
                        setNewColor(PRESET_COLORS[0])
                      }
                    }}
                    placeholder="Nieuwe categorie..."
                    style={styles.editInput}
                    autoFocus
                  />
                  <button style={styles.iconButton} onClick={handleAdd}>
                    <Check size={16} color="#4ade80" />
                  </button>
                  <button style={styles.iconButton} onClick={() => {
                    setIsAdding(false)
                    setNewLabel('')
                    setNewColor(PRESET_COLORS[0])
                  }}>
                    <X size={16} color="#888" />
                  </button>
                </div>
                <div style={styles.colorPicker}>
                  {PRESET_COLORS.map(color => (
                    <button
                      key={color}
                      style={{
                        ...styles.colorSwatch,
                        backgroundColor: color,
                        ...(newColor === color ? styles.colorSwatchSelected : {}),
                      }}
                      onClick={() => setNewColor(color)}
                    />
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <button style={styles.addButton} onClick={() => setIsAdding(true)}>
              <Plus size={16} />
              Nieuwe categorie
            </button>
          )}
        </div>
      </div>

      <div style={styles.section}>
        <button style={styles.resetButton} onClick={handleReset}>
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
    gap: 12,
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
  categoryList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  categoryItem: {
    backgroundColor: '#252545',
    borderRadius: 8,
    padding: '10px 14px',
  },
  viewRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  labelWithColor: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  colorDot: {
    position: 'relative',
    width: 20,
    height: 20,
    cursor: 'pointer',
  },
  colorDotInner: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 20,
    height: 20,
    borderRadius: '50%',
    pointerEvents: 'none',
  },
  colorInput: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 20,
    height: 20,
    opacity: 0,
    cursor: 'pointer',
  },
  categoryLabel: {
    fontSize: 14,
    color: '#fff',
    fontWeight: 500,
  },
  actions: {
    display: 'flex',
    gap: 4,
  },
  editContainer: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  editRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  editInput: {
    flex: 1,
    padding: '6px 10px',
    backgroundColor: '#1a1a2e',
    border: '1px solid #444',
    borderRadius: 6,
    color: '#fff',
    fontSize: 14,
    outline: 'none',
  },
  colorPicker: {
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap',
  },
  colorSwatch: {
    width: 24,
    height: 24,
    borderRadius: 4,
    border: '2px solid transparent',
    cursor: 'pointer',
    transition: 'transform 0.1s, border-color 0.1s',
  },
  colorSwatchSelected: {
    borderColor: '#fff',
    transform: 'scale(1.1)',
  },
  iconButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    backgroundColor: 'transparent',
    border: 'none',
    borderRadius: 4,
    color: '#888',
    cursor: 'pointer',
    transition: 'color 0.2s',
  },
  addButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: '10px 14px',
    backgroundColor: 'transparent',
    border: '1px dashed #444',
    borderRadius: 8,
    color: '#888',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.2s',
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
