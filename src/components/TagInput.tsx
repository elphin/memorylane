import { useState, useRef, KeyboardEvent } from 'react'
import { X, Tag } from 'lucide-react'

interface TagInputProps {
  tags: string[]
  onChange: (tags: string[]) => void
  placeholder?: string
}

export function TagInput({ tags, onChange, placeholder = 'Voeg tag toe...' }: TagInputProps) {
  const [inputValue, setInputValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && inputValue.trim()) {
      e.preventDefault()
      const newTag = inputValue.trim().toLowerCase()
      if (!tags.includes(newTag)) {
        onChange([...tags, newTag])
      }
      setInputValue('')
    } else if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
      // Remove last tag when backspace is pressed on empty input
      onChange(tags.slice(0, -1))
    }
  }

  const removeTag = (tagToRemove: string) => {
    onChange(tags.filter(tag => tag !== tagToRemove))
  }

  return (
    <div style={styles.container} onClick={() => inputRef.current?.focus()}>
      <div style={styles.tagIcon}>
        <Tag size={14} />
      </div>
      <div style={styles.tagsWrapper}>
        {tags.map((tag) => (
          <span key={tag} style={styles.tag}>
            {tag}
            <button
              type="button"
              style={styles.removeButton}
              onClick={(e) => {
                e.stopPropagation()
                removeTag(tag)
              }}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          style={styles.input}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={tags.length === 0 ? placeholder : ''}
        />
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: '#252545',
    borderRadius: 8,
    padding: '8px 12px',
    minHeight: 40,
    cursor: 'text',
  },
  tagIcon: {
    color: '#666',
    marginTop: 4,
    flexShrink: 0,
  },
  tagsWrapper: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    flex: 1,
    alignItems: 'center',
  },
  tag: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#3d5a80',
    color: '#fff',
    fontSize: 12,
    fontWeight: 500,
    padding: '4px 8px',
    borderRadius: 12,
  },
  removeButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'none',
    border: 'none',
    color: 'rgba(255,255,255,0.7)',
    cursor: 'pointer',
    padding: 0,
    marginLeft: 2,
  },
  input: {
    flex: 1,
    minWidth: 80,
    background: 'none',
    border: 'none',
    color: '#fff',
    fontSize: 14,
    outline: 'none',
    padding: '4px 0',
    fontFamily: 'inherit',
  },
}
