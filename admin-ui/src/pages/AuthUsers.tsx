import { Plus, Trash2, KeyRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { Button, Empty, Input, Label, Modal, Spinner } from '../components/ui'

export function AuthUsers() {
  const [users, setUsers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [resetting, setResetting] = useState<any | null>(null)

  async function load() {
    setUsers(await api.users())
  }
  useEffect(() => {
    load().finally(() => setLoading(false))
  }, [])

  async function del(u: any) {
    if (!confirm(`Delete ${u.email || u.id}?`)) return
    await api.deleteUser(u.id)
    await load()
  }

  if (loading) return <Spinner />

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-2.5">
        <span className="text-sm font-semibold">Users</span>
        <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-400">{users.length}</span>
        <Button size="xs" className="ml-auto" onClick={() => setCreating(true)}>
          <Plus size={13} /> Add user
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead className="sticky top-0 bg-[#1c1c1c]">
            <tr className="border-b border-neutral-800 text-left text-neutral-400">
              <th className="px-4 py-1.5 font-medium">Email</th>
              <th className="px-3 py-1.5 font-medium">UID</th>
              <th className="px-3 py-1.5 font-medium">Provider</th>
              <th className="px-3 py-1.5 font-medium">Created</th>
              <th className="px-3 py-1.5 font-medium">Last sign in</th>
              <th className="w-20" />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="group border-b border-neutral-800/60 hover:bg-neutral-800/30">
                <td className="px-4 py-1.5">
                  {u.email || <span className="text-neutral-500">{u.is_anonymous ? 'anonymous' : '—'}</span>}
                </td>
                <td className="px-3 py-1.5 font-mono text-[11px] text-neutral-500">{u.id.slice(0, 8)}…</td>
                <td className="px-3 py-1.5 text-neutral-400">{u.app_metadata?.provider || '—'}</td>
                <td className="px-3 py-1.5 text-neutral-400">{(u.created_at || '').slice(0, 10)}</td>
                <td className="px-3 py-1.5 text-neutral-400">{(u.last_sign_in_at || '').slice(0, 16).replace('T', ' ')}</td>
                <td className="px-3">
                  <div className="flex gap-0.5 opacity-0 group-hover:opacity-100">
                    <button className="p-1 text-neutral-500 hover:text-brand" title="Reset password" onClick={() => setResetting(u)}>
                      <KeyRound size={13} />
                    </button>
                    <button className="p-1 text-neutral-500 hover:text-red-400" onClick={() => del(u)}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {users.length === 0 && <Empty>No users yet.</Empty>}
      </div>

      {creating && (
        <CreateUser
          onClose={() => setCreating(false)}
          onDone={async () => {
            setCreating(false)
            await load()
          }}
        />
      )}
      {resetting && (
        <ResetPassword
          user={resetting}
          onClose={() => setResetting(null)}
          onDone={async () => {
            setResetting(null)
            await load()
          }}
        />
      )}
    </div>
  )
}

function CreateUser({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit() {
    setBusy(true)
    setErr('')
    try {
      await api.createUser({ email, password: password || undefined, email_confirm: true })
      onDone()
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose} title="Add user">
      <div className="space-y-3">
        <div>
          <Label>Email</Label>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@example.com" />
        </div>
        <div>
          <Label>Password (optional)</Label>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {err && <p className="text-xs text-red-400">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !email}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function ResetPassword({ user, onClose, onDone }: { user: any; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit() {
    setBusy(true)
    setErr('')
    try {
      await api.updateUser(user.id, { password })
      onDone()
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose} title={`Reset password · ${user.email || user.id}`}>
      <div className="space-y-3">
        <div>
          <Label>New password</Label>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {err && <p className="text-xs text-red-400">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || password.length < 6}>
            {busy ? 'Saving…' : 'Update'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
