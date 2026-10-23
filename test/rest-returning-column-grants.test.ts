import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, type TinbaseBackend } from '../src/index.js'
import { testEngine } from './helpers.js'

/**
 * Writes that ask for their row back on a table with column-level SELECT grants.
 *
 * The usual way to hide a secret column from clients is
 * `revoke select on t from anon, authenticated; grant select (a, b) on t to …`.
 * The mutation CTE used to be `… returning *`, which makes Postgres check SELECT
 * on every column, so `.insert(row).select('a, b')` failed with 42501 on such a
 * table even though every selected column was readable (SherTrack, 2026-10-23:
 * no new user got its identity row for two hours). PostgREST returns only the
 * selected columns; so must we.
 */
const MIGRATION = `
create table devices (
  id serial primary key,
  name text not null,
  code text not null,
  secret text
);
alter table devices enable row level security;
create policy devices_all on devices for all to anon using (true) with check (true);
revoke select on devices from anon, authenticated;
grant select (id, name, code) on devices to anon, authenticated;
grant insert, update, delete on devices to anon, authenticated;

create table pings (
  id serial primary key,
  device_id int references devices(id),
  note text
);
alter table pings enable row level security;
create policy pings_all on pings for all to anon using (true) with check (true);
grant select, insert on pings to anon, authenticated;
`

let backend: TinbaseBackend

beforeAll(async () => {
  backend = await createBackend({
    engine: await testEngine(),
    migrations: [{ name: '20240101000000_column_grants', sql: MIGRATION }],
  })
})

afterAll(async () => {
  await backend.close()
})

function asAnon(path: string, init: RequestInit & { prefer?: string; object?: boolean } = {}) {
  const headers: Record<string, string> = {
    apikey: backend.anonKey,
    Authorization: `Bearer ${backend.anonKey}`,
    'content-type': 'application/json',
  }
  if (init.prefer) headers.Prefer = init.prefer
  if (init.object) headers.Accept = 'application/vnd.pgrst.object+json'
  return backend.fetch(new Request(`http://localhost:54321/rest/v1/${path}`, { ...init, headers }))
}

describe('mutations returning rows on a table with column-level grants', () => {
  it('insert … select=<readable columns> returns the row', async () => {
    const res = await asAnon('devices?select=id,name,code', {
      method: 'POST',
      prefer: 'return=representation',
      object: true,
      body: JSON.stringify({ name: 'Pixel', code: 'ST-AAAA-BBBB', secret: 'hidden' }),
    })
    expect(res.status).toBe(201)
    const row = (await res.json()) as Record<string, unknown>
    expect(row).toEqual({ id: expect.any(Number), name: 'Pixel', code: 'ST-AAAA-BBBB' })
  })

  it('insert … select=* is still refused, as PostgREST refuses it', async () => {
    const res = await asAnon('devices', {
      method: 'POST',
      prefer: 'return=representation',
      body: JSON.stringify({ name: 'Nope', code: 'ST-CCCC-DDDD' }),
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('42501')
  })

  it('update … select=<readable columns> returns the row', async () => {
    const res = await asAnon('devices?code=eq.ST-AAAA-BBBB&select=name,code', {
      method: 'PATCH',
      prefer: 'return=representation',
      body: JSON.stringify({ name: 'Pixel 9' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ name: 'Pixel 9', code: 'ST-AAAA-BBBB' }])
  })

  it('update on the hidden column alone, no representation, is fine', async () => {
    const res = await asAnon('devices?code=eq.ST-AAAA-BBBB', {
      method: 'PATCH',
      body: JSON.stringify({ secret: 'rotated' }),
    })
    expect(res.status).toBe(204)
  })

  it('a json arrow path and an embed return only the base columns they read', async () => {
    const ping = await asAnon('pings?select=note,devices(name)', {
      method: 'POST',
      prefer: 'return=representation',
      object: true,
      body: JSON.stringify({ device_id: 1, note: 'hello' }),
    })
    expect(ping.status).toBe(201)
    expect(await ping.json()).toEqual({ note: 'hello', devices: { name: 'Pixel 9' } })
  })

  it('delete … select=<readable columns> returns the row', async () => {
    const made = await asAnon('devices', {
      method: 'POST',
      body: JSON.stringify({ name: 'Spare', code: 'ST-EEEE-FFFF', secret: 's' }),
    })
    expect(made.status).toBe(201)
    const res = await asAnon('devices?code=eq.ST-EEEE-FFFF&select=name,code', {
      method: 'DELETE',
      prefer: 'return=representation',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ name: 'Spare', code: 'ST-EEEE-FFFF' }])
  })
})
