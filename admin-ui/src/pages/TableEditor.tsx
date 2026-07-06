import { ChevronLeft, ChevronRight, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api, type TableInfo } from '../api'
import { Button, Empty, Input, Label, Modal, Spinner } from '../components/ui'

const PAGE = 50

export function TableEditor() {
  const [tables, setTables] = useState<TableInfo[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null)
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState('')

  const table = tables.find((t) => t.name === active) || null

  const loadTables = useCallback(async () => {
    const t = await api.tables()
    setTables(t)
    setActive((cur) => cur ?? t[0]?.name ?? null)
  }, [])

  useEffect(() => {
    loadTables().finally(() => setLoading(false))
  }, [loadTables])

  const loadRows = useCallback(async () => {
    if (!active || !table) return
    const order = table.primaryKey[0] ? `${table.primaryKey[0]}.asc` : undefined
    const { rows, total } = await api.rows(active, { limit: PAGE, offset: page * PAGE, order })
    setRows(rows)
    setTotal(total)
  }, [active, page, table])

  useEffect(() => {
    void loadRows()
  }, [loadRows])

  function pkOf(row: Record<string, unknown>): Record<string, unknown> {
    const pk: Record<string, unknown> = {}
    for (const k of table!.primaryKey) pk[k] = row[k]
    return pk
  }

  async function del(row: Record<string, unknown>) {
    if (!table?.primaryKey.length) return alert('Cannot delete: table has no primary key')
    if (!confirm('Delete this row?')) return
    try {
      await api.deleteRow(active!, pkOf(row))
      await loadRows()
      await loadTables()
    } catch (e) {
      alert((e as Error).message)
    }
  }

  if (loading) return <Spinner />

  return (
    <div className="flex h-full">
      {/* table list */}
      <div className="flex w-60 shrink-0 flex-col border-r border-neutral-800 bg-[#191919]">
        <div className="flex items-center justify-between px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Tables <span className="text-neutral-600">{tables.length}</span>
        </div>
        <div className="flex-1 overflow-auto">
          {tables.map((t) => (
            <button
              key={t.name}
              onClick={() => {
                setActive(t.name)
                setPage(0)
              }}
              className={
                'flex w-full items-center justify-between px-3 py-1.5 text-left text-[13px] ' +
                (active === t.name ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-850 hover:bg-neutral-800/50')
              }
            >
              <span className="truncate font-mono">{t.name}</span>
              <span className="text-[11px] text-neutral-600">{t.rowCount}</span>
            </button>
          ))}
          {tables.length === 0 && <Empty>No tables. Create one in the SQL Editor.</Empty>}
        </div>
      </div>

      {/* grid */}
      <div className="flex min-w-0 flex-1 flex-col">
        {table ? (
          <>
            <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-2.5">
              <span className="font-mono text-sm">{table.name}</span>
              <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-400">{total} rows</span>
              <div className="ml-auto flex items-center gap-1.5">
                <Button variant="ghost" size="xs" onClick={() => void loadRows()}>
                  <RefreshCw size={13} />
                </Button>
                <Button size="xs" onClick={() => setCreating(true)}>
                  <Plus size={13} /> Insert
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead className="sticky top-0 z-10 bg-[#1c1c1c]">
                  <tr className="border-b border-neutral-800">
                    <th className="w-16 px-2 py-1.5" />
                    {table.columns.map((c) => (
                      <th key={c.name} className="whitespace-nowrap px-3 py-1.5 text-left font-medium text-neutral-400">
                        <span className="font-mono text-neutral-200">{c.name}</span>
                        {c.isPrimaryKey && <span className="ml-1 text-[10px] text-brand">PK</span>}
                        <span className="ml-1.5 text-[11px] font-normal text-neutral-600">{c.type}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i} className="group border-b border-neutral-850 border-neutral-800/60 hover:bg-neutral-800/30">
                      <td className="px-2">
                        <div className="flex gap-0.5 opacity-0 group-hover:opacity-100">
                          <button className="p-1 text-neutral-500 hover:text-brand" onClick={() => setEditing(row)}>
                            <Pencil size={13} />
                          </button>
                          <button className="p-1 text-neutral-500 hover:text-red-400" onClick={() => del(row)}>
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                      {table.columns.map((c) => (
                        <td key={c.name} className="max-w-[320px] truncate px-3 py-1.5 font-mono text-neutral-300">
                          <Cell value={row[c.name]} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length === 0 && <Empty>No rows yet.</Empty>}
            </div>
            <div className="flex items-center gap-2 border-t border-neutral-800 px-4 py-2 text-xs text-neutral-500">
              <Button variant="ghost" size="xs" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                <ChevronLeft size={13} />
              </Button>
              <span>
                {total === 0 ? 0 : page * PAGE + 1}–{Math.min((page + 1) * PAGE, total)} of {total}
              </span>
              <Button variant="ghost" size="xs" disabled={(page + 1) * PAGE >= total} onClick={() => setPage((p) => p + 1)}>
                <ChevronRight size={13} />
              </Button>
            </div>
          </>
        ) : (
          <Empty>Select a table.</Empty>
        )}
      </div>

      {editing && table && (
        <RowForm
          table={table}
          initial={editing}
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            await api.updateRow(active!, pkOf(editing), patch)
            setEditing(null)
            await loadRows()
          }}
        />
      )}
      {creating && table && (
        <RowForm
          table={table}
          initial={{}}
          isNew
          onClose={() => setCreating(false)}
          onSave={async (row) => {
            await api.insertRow(active!, row)
            setCreating(false)
            await loadRows()
            await loadTables()
          }}
        />
      )}
      {err && <p className="text-red-400">{err}</p>}
    </div>
  )
}

function Cell({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-neutral-600">NULL</span>
  if (typeof value === 'boolean') return <span className="text-blue-400">{String(value)}</span>
  if (typeof value === 'object') return <span className="text-amber-300/80">{JSON.stringify(value)}</span>
  return <>{String(value)}</>
}

function RowForm({
  table,
  initial,
  isNew,
  onClose,
  onSave,
}: {
  table: TableInfo
  initial: Record<string, unknown>
  isNew?: boolean
  onClose: () => void
  onSave: (row: Record<string, unknown>) => Promise<void>
}) {
  const editable = table.columns.filter((c) => !(isNew && c.isPrimaryKey && c.hasDefault))
  const [form, setForm] = useState<Record<string, string>>(() => {
    const f: Record<string, string> = {}
    for (const c of editable) {
      const v = initial[c.name]
      f[c.name] = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
    }
    return f
  })
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    setErr('')
    const out: Record<string, unknown> = {}
    for (const c of editable) {
      if (!isNew && !touched[c.name]) continue
      const raw = form[c.name]
      if (raw === '' && (c.nullable || c.hasDefault)) {
        if (!isNew) out[c.name] = null
        continue
      }
      out[c.name] = coerce(raw, c.type)
    }
    try {
      await onSave(out)
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={isNew ? `Insert into ${table.name}` : `Edit row in ${table.name}`} wide>
      <div className="space-y-3">
        {editable.map((c) => (
          <div key={c.name}>
            <Label>
              {c.name}
              <span className="ml-1.5 font-normal text-neutral-600">
                {c.type}
                {c.isPrimaryKey ? ' · PK' : ''}
                {!c.nullable && !c.hasDefault ? ' · required' : ''}
              </span>
            </Label>
            <Input
              value={form[c.name] ?? ''}
              placeholder={c.hasDefault ? 'default' : c.nullable ? 'NULL' : ''}
              onChange={(e) => {
                setForm((f) => ({ ...f, [c.name]: e.target.value }))
                setTouched((t) => ({ ...t, [c.name]: true }))
              }}
            />
          </div>
        ))}
        {err && <p className="text-xs text-red-400">{err}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : isNew ? 'Insert' : 'Save'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function coerce(raw: string, type: string): unknown {
  if (type === 'bool') return raw === 'true' || raw === 't' || raw === '1'
  if (['int2', 'int4', 'int8', 'float4', 'float8', 'numeric'].includes(type)) {
    const n = Number(raw)
    return Number.isNaN(n) ? raw : n
  }
  if (type === 'json' || type === 'jsonb') {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  if (type.startsWith('_')) {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  return raw
}
