import { z } from 'zod'

/**
 * Opaque keyset cursors (docs/api.md, section 1.4). Lists are ordered newest
 * first by UUIDv7 id, an immutable and unique key, so a page boundary never
 * skips or repeats a row even while other rows are inserted or edited. The
 * cursor is the last id of the page, wrapped so its format can change later.
 */
const payloadSchema = z.strictObject({ v: z.literal(1), id: z.uuid() })

export function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, id })).toString('base64url')
}

/** The id to continue after, or `undefined` for a cursor the API did not issue. */
export function decodeCursor(cursor: string): string | undefined {
  try {
    const payload: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    const parsed = payloadSchema.safeParse(payload)
    return parsed.success ? parsed.data.id : undefined
  } catch {
    return undefined
  }
}

/** Rows were fetched with `limit + 1`: the extra row only proves a next page exists. */
export function toPage<Row extends { id: string }, Item>(
  rows: readonly Row[],
  limit: number,
  map: (row: Row) => Item,
): { items: Item[]; nextCursor: string | null } {
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map(map),
    nextCursor: rows.length > limit && last ? encodeCursor(last.id) : null,
  }
}
