import { customType } from 'drizzle-orm/pg-core'

/** PostgreSQL `bytea` as a Node `Buffer` (drizzle-orm 0.45 has no built-in bytea column). */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea'
  },
})
