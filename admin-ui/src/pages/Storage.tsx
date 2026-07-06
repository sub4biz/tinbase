import { Plus, Trash2, Upload, File } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { Button, Empty, Input, Label, Modal, Spinner } from '../components/ui'

export function Storage() {
  const [buckets, setBuckets] = useState<any[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [objects, setObjects] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function loadBuckets() {
    const b = await api.buckets()
    setBuckets(b)
    setActive((cur) => cur ?? b[0]?.id ?? null)
  }
  async function loadObjects(bucket: string) {
    setObjects(await api.listObjects(bucket))
  }
  useEffect(() => {
    loadBuckets().finally(() => setLoading(false))
  }, [])
  useEffect(() => {
    if (active) void loadObjects(active)
  }, [active])

  async function upload(file: File) {
    if (!active) return
    await api.uploadObject(active, file.name, file)
    await loadObjects(active)
  }
  async function delObject(name: string) {
    if (!active || !confirm(`Delete ${name}?`)) return
    await api.removeObject(active, name)
    await loadObjects(active)
  }
  async function delBucket(id: string) {
    if (!confirm(`Delete bucket "${id}"? It must be empty.`)) return
    try {
      await api.deleteBucket(id)
      setActive(null)
      await loadBuckets()
    } catch (e) {
      alert((e as Error).message)
    }
  }

  if (loading) return <Spinner />

  return (
    <div className="flex h-full">
      <div className="flex w-60 shrink-0 flex-col border-r border-neutral-800 bg-[#191919]">
        <div className="flex items-center justify-between px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Buckets
          <button className="text-neutral-400 hover:text-brand" onClick={() => setCreating(true)}>
            <Plus size={14} />
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          {buckets.map((b) => (
            <button
              key={b.id}
              onClick={() => setActive(b.id)}
              className={
                'group flex w-full items-center justify-between px-3 py-1.5 text-left text-[13px] ' +
                (active === b.id ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-800/50')
              }
            >
              <span className="truncate">
                {b.id}
                {b.public && <span className="ml-1.5 text-[10px] text-brand">public</span>}
              </span>
              <Trash2
                size={13}
                className="opacity-0 hover:text-red-400 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation()
                  delBucket(b.id)
                }}
              />
            </button>
          ))}
          {buckets.length === 0 && <Empty>No buckets.</Empty>}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {active ? (
          <>
            <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-2.5">
              <span className="font-mono text-sm">{active}</span>
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
              />
              <Button size="xs" className="ml-auto" onClick={() => fileRef.current?.click()}>
                <Upload size={13} /> Upload
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {objects.map((o) => (
                <div
                  key={o.name}
                  className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-neutral-800/40"
                >
                  <File size={14} className="text-neutral-500" />
                  <span className="font-mono">{o.name}</span>
                  {o.metadata?.size != null && (
                    <span className="text-[11px] text-neutral-500">{fmtSize(o.metadata.size)}</span>
                  )}
                  <button
                    className="ml-auto p-1 text-neutral-500 opacity-0 hover:text-red-400 group-hover:opacity-100"
                    onClick={() => delObject(o.name)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              {objects.length === 0 && <Empty>Empty bucket. Upload a file.</Empty>}
            </div>
          </>
        ) : (
          <Empty>Select or create a bucket.</Empty>
        )}
      </div>

      {creating && (
        <CreateBucket
          onClose={() => setCreating(false)}
          onDone={async () => {
            setCreating(false)
            await loadBuckets()
          }}
        />
      )}
    </div>
  )
}

function CreateBucket({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('')
  const [pub, setPub] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit() {
    setBusy(true)
    setErr('')
    try {
      await api.createBucket({ id: name, name, public: pub })
      onDone()
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose} title="New bucket">
      <div className="space-y-3">
        <div>
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="avatars" />
        </div>
        <label className="flex items-center gap-2 text-[13px] text-neutral-300">
          <input type="checkbox" checked={pub} onChange={(e) => setPub(e.target.checked)} />
          Public bucket (objects readable without auth)
        </label>
        {err && <p className="text-xs text-red-400">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !name}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
