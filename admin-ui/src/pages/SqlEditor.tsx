import { Play } from 'lucide-react'
import { useState } from 'react'
import { api } from '../api'
import { Button, Empty, Textarea } from '../components/ui'

type Result = Awaited<ReturnType<typeof api.sql>>

export function SqlEditor() {
  const [query, setQuery] = useState('select * from ')
  const [result, setResult] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)

  async function run() {
    setBusy(true)
    setResult(await api.sql(query))
    setBusy(false)
  }

  const cols = result?.rows?.[0] ? Object.keys(result.rows[0]) : []

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-neutral-800 p-3">
        <Textarea
          className="h-40"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && run()}
          spellCheck={false}
          placeholder="select * from …   (⌘⏎ to run)"
        />
        <div className="mt-2 flex items-center gap-3">
          <Button onClick={run} disabled={busy}>
            <Play size={13} /> Run
          </Button>
          <span className="text-xs text-neutral-500">⌘⏎</span>
          {result && (
            <span className="ml-auto text-xs text-neutral-500">
              {result.ok
                ? `${result.rowCount} rows · ${result.ms} ms${result.affectedRows != null ? ` · ${result.affectedRows} affected` : ''}`
                : ''}
            </span>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!result && <Empty>Run a query to see results.</Empty>}
        {result && !result.ok && (
          <div className="m-4 rounded-md border border-red-900/50 bg-red-950/30 p-3 text-[13px] text-red-300">
            <div className="font-mono">{result.error}</div>
            {result.code && <div className="mt-1 text-xs text-red-400/70">SQLSTATE {result.code}</div>}
            {result.hint && <div className="mt-1 text-xs text-neutral-400">Hint: {result.hint}</div>}
          </div>
        )}
        {result?.ok && cols.length > 0 && (
          <table className="w-full border-collapse text-[13px]">
            <thead className="sticky top-0 bg-[#1c1c1c]">
              <tr className="border-b border-neutral-800">
                {cols.map((c) => (
                  <th key={c} className="whitespace-nowrap px-3 py-1.5 text-left font-mono font-medium text-neutral-300">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows!.map((row, i) => (
                <tr key={i} className="border-b border-neutral-800/60 hover:bg-neutral-800/30">
                  {cols.map((c) => (
                    <td key={c} className="max-w-[360px] truncate px-3 py-1.5 font-mono text-neutral-300">
                      {fmt(row[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {result?.ok && cols.length === 0 && (
          <Empty>Statement executed{result.affectedRows != null ? ` · ${result.affectedRows} rows affected` : ''}.</Empty>
        )}
      </div>
    </div>
  )
}

function fmt(v: unknown) {
  if (v === null || v === undefined) return <span className="text-neutral-600">NULL</span>
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
