import { useEffect, useState } from 'react'
import { api, type Stats } from '../api'
import { Empty, Spinner } from '../components/ui'

export function DatabasePage() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [migrations, setMigrations] = useState<{ version: string; name: string | null; applied_at: string }[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([api.stats(), api.migrations()])
      .then(([s, m]) => {
        setStats(s)
        setMigrations(m)
      })
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Spinner />

  return (
    <div className="h-full overflow-auto p-6">
      <h1 className="text-sm font-semibold text-neutral-300">Database</h1>
      {stats && (
        <>
          <p className="mt-1 font-mono text-xs text-neutral-500">{stats.version}</p>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Tables" value={stats.tables} />
            <Stat label="Users" value={stats.users} />
            <Stat label="Buckets" value={stats.buckets} />
            <Stat label="Objects" value={stats.objects} />
            <Stat label="Migrations" value={stats.migrations} />
            <Stat label="DB size" value={stats.dbSize} />
          </div>
        </>
      )}

      <h2 className="mb-2 mt-8 text-xs font-semibold uppercase tracking-wide text-neutral-500">Migrations</h2>
      <div className="overflow-hidden rounded-md border border-neutral-800">
        <table className="w-full border-collapse text-[13px]">
          <thead className="bg-[#191919]">
            <tr className="border-b border-neutral-800 text-left text-neutral-400">
              <th className="px-4 py-2 font-medium">Version</th>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Applied</th>
            </tr>
          </thead>
          <tbody>
            {migrations.map((m) => (
              <tr key={m.version} className="border-b border-neutral-800/60">
                <td className="px-4 py-1.5 font-mono text-neutral-400">{m.version}</td>
                <td className="px-4 py-1.5 font-mono">{m.name || '—'}</td>
                <td className="px-4 py-1.5 text-neutral-400">{(m.applied_at || '').slice(0, 19).replace('T', ' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {migrations.length === 0 && <Empty>No migrations applied.</Empty>}
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-[#191919] p-3">
      <div className="text-lg font-semibold text-neutral-100">{value}</div>
      <div className="text-xs text-neutral-500">{label}</div>
    </div>
  )
}
