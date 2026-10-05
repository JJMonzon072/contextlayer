import { z } from 'zod'

/**
 * Keyset pagination (docs/api.md, section 1.4): `?limit=` and an opaque
 * `?cursor=` taken from the previous page's `nextCursor`. The API decodes and
 * validates the cursor; clients never build one.
 */
export const PAGE_LIMIT_DEFAULT = 20
export const PAGE_LIMIT_MAX = 100

export const pageCursorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/, 'Invalid cursor.')

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
  cursor: pageCursorSchema.optional(),
})

export function pageSchema<Item extends z.ZodType>(item: Item) {
  return z.object({
    items: z.array(item),
    /** `null` on the last page. */
    nextCursor: pageCursorSchema.nullable(),
  })
}

export type PageQuery = z.infer<typeof pageQuerySchema>
