'use client'

import { useState, useRef } from 'react'
import toast from 'react-hot-toast'

interface ResumeUploadProps {
  currentPath?: string | null
  onUploaded: (path: string) => void
}

export function ResumeUpload({ currentPath, onUploaded }: ResumeUploadProps) {
  const [uploading, setUploading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const filename = currentPath ? currentPath.split('/').pop() : null

  async function handleFile(file: File) {
    if (file.type !== 'application/pdf') {
      toast.error('Please upload a PDF file')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('File must be under 5MB')
      return
    }

    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('resume', file)
      const res = await fetch('/api/upload', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Upload failed')
      onUploaded(data.resumePath)
      toast.success('Resume uploaded')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium" style={{ color: 'var(--color-text-secondary)' }}>
        Resume (PDF)
      </label>

      <div
        className="relative border-2 border-dashed rounded-xl p-6 text-center transition-all cursor-pointer"
        style={{
          borderColor: isDragging ? 'var(--color-accent)' : 'var(--color-border)',
          background: isDragging ? 'var(--color-accent-subtle)' : 'var(--color-surface)',
        }}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setIsDragging(false)
          const file = e.dataTransfer.files[0]
          if (file) handleFile(file)
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleFile(file)
          }}
        />

        {uploading ? (
          <div className="flex flex-col items-center gap-2">
            <div className="w-5 h-5 rounded-full border-2 border-t-transparent animate-spin"
              style={{ borderColor: 'var(--color-accent)' }} />
            <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>Uploading…</p>
          </div>
        ) : filename ? (
          <div className="flex flex-col items-center gap-2">
            <div className="text-2xl">📄</div>
            <p className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>{filename}</p>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Click to replace</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <div className="text-2xl">↑</div>
            <p className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
              Drop your resume here
            </p>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>PDF only, max 5MB</p>
          </div>
        )}
      </div>
    </div>
  )
}
