import { afterEach, describe, expect, it } from 'vitest'
import { createBackend, createPgliteEngine, type TinbaseBackend } from '../src/index.js'

// A migration that fails on the data already in the database must not take the
// server down. In production a user's app added a CHECK constraint that one of
// its existing rows violated: startup threw, the process exited, the container
// restarted into the same migration, and the app was unreachable for everyone
// until the file was fixed - while the schema that had applied, and every row,
// were healthy throughout.

const T = 60_000

let backend: TinbaseBackend | null = null
afterEach(async () => {
  if (backend) await backend.close()
  backend = null
})

const CREATE = {
  name: '20240101000000_quotes',
  sql: `create table quotes (id text primary key, kind text not null);`,
}
// The rows the app already holds: one of them is a kind the later CHECK forbids.
const ROWS = `insert into quotes (id, kind) values ('a', 'maintenance'), ('b', 'construction');`
const NARROW = {
  name: '20240102000000_narrow_kind',
  sql: `alter table quotes add constraint quotes_kind_check check (kind in ('maintenance', 'other'));`,
}
const LATER = {
  name: '20240103000000_add_total',
  sql: `alter table quotes add column total numeric;`,
}

/** One PGlite database, opened twice: first with the old migrations, then with the new ones. */
async function restartWith(migrations: { name: string; sql: string }[]) {
  const engine = await createPgliteEngine()
  backend = await createBackend({ engine, migrations: [CREATE] })
  await backend.db.exec(ROWS)
  // A restart with the new files is a second run over the same database.
  const applied = await backend.db.runMigrations(migrations, undefined, { stopOnFailure: true })
  return applied
}

describe('a migration that fails on live data leaves the server up', () => {
  it(
    'starts, serves the existing schema and rows, and reports the failed migration',
    async () => {
      const engine = await createPgliteEngine()
      const first = await createBackend({ engine, migrations: [CREATE] })
      await first.db.exec(ROWS)
      // Same engine, as a restarted server would see it: createBackend must not throw.
      backend = await createBackend({ engine, migrations: [CREATE, NARROW, LATER] })

      const rows = await backend.db.query(`select id from quotes order by id`)
      expect(rows.rows.map((r: { id: string }) => r.id)).toEqual(['a', 'b'])

      const failed = backend.db.migrationFailure
      expect(failed?.name).toBe(NARROW.name)
      expect(failed?.code).toBe('23514')
      expect(failed?.error).toMatch(/quotes_kind_check/)
      // Later migrations wait: they may depend on the failed one, and order matters.
      expect(failed?.skipped).toEqual([LATER.name])

      const ledger = await backend.db.listAppliedMigrations()
      expect(ledger.map((m) => m.name)).toEqual([CREATE.name])
    },
    T
  )

  it(
    'rolls the failed migration back completely',
    async () => {
      await restartWith([CREATE, NARROW])
      const constraints = await backend!.db.query(
        `select 1 from pg_constraint where conname = 'quotes_kind_check'`
      )
      expect(constraints.rows).toHaveLength(0)
    },
    T
  )

  it(
    'applies a corrected migration, and the ones after it, on the next run',
    async () => {
      await restartWith([CREATE, NARROW, LATER])
      expect(backend!.db.migrationFailure?.name).toBe(NARROW.name)

      const fixed = {
        ...NARROW,
        sql: `alter table quotes add constraint quotes_kind_check check (kind in ('maintenance', 'construction', 'other'));`,
      }
      const applied = await backend!.db.runMigrations([CREATE, fixed, LATER], undefined, { stopOnFailure: true })
      expect(applied).toEqual([NARROW.name, LATER.name])
      expect(backend!.db.migrationFailure).toBeNull()
    },
    T
  )

  it(
    'exposes the failure on /admin/v1/migrations',
    async () => {
      await restartWith([CREATE, NARROW])
      const res = await backend!.fetch(
        new Request('http://localhost:54321/admin/v1/migrations', {
          headers: { apikey: backend!.serviceRoleKey, authorization: `Bearer ${backend!.serviceRoleKey}` },
        })
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { migrations: unknown[]; failed: { name: string; code?: string } | null }
      expect(body.failed?.name).toBe(NARROW.name)
      expect(body.failed?.code).toBe('23514')
    },
    T
  )

  it(
    'still throws for an explicit migrate (runtime migrate, CLI and admin endpoint)',
    async () => {
      const engine = await createPgliteEngine()
      backend = await createBackend({ engine, migrations: [CREATE] })
      await backend.db.exec(ROWS)
      await expect(backend.migrate([CREATE, NARROW])).rejects.toThrow(/quotes_kind_check/)
      expect(backend.db.migrationFailure?.name).toBe(NARROW.name)
    },
    T
  )

  it(
    'health stays 200 while a migration is pending',
    async () => {
      await restartWith([CREATE, NARROW])
      const res = await backend!.fetch(new Request('http://localhost:54321/health'))
      expect(res.status).toBe(200)
    },
    T
  )
})
