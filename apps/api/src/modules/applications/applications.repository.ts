import { and, desc, eq, lt } from 'drizzle-orm'

import { isForeignKeyViolation, type DbExecutor } from '../../infrastructure/database/client.js'
import { applications } from './applications.schema.js'

/**
 * Every function takes the `workspaceId`: there is no unscoped lookup by id, so
 * an id from another workspace behaves exactly like an id that does not exist.
 */

const columns = {
  id: applications.id,
  name: applications.name,
  origins: applications.origins,
  createdAt: applications.createdAt,
  updatedAt: applications.updatedAt,
}

export interface ApplicationRow {
  id: string
  name: string
  origins: string[]
  createdAt: Date
  updatedAt: Date
}

/** Newest first; `afterId` continues after the previous page. Fetches `limit + 1` rows. */
export function listApplications(
  db: DbExecutor,
  workspaceId: string,
  page: { limit: number; afterId: string | undefined },
): Promise<ApplicationRow[]> {
  return db
    .select(columns)
    .from(applications)
    .where(
      and(
        eq(applications.workspaceId, workspaceId),
        page.afterId === undefined ? undefined : lt(applications.id, page.afterId),
      ),
    )
    .orderBy(desc(applications.id))
    .limit(page.limit + 1)
}

export async function findApplication(
  db: DbExecutor,
  workspaceId: string,
  applicationId: string,
): Promise<ApplicationRow | undefined> {
  const [row] = await db
    .select(columns)
    .from(applications)
    .where(and(eq(applications.workspaceId, workspaceId), eq(applications.id, applicationId)))
  return row
}

export async function insertApplication(
  db: DbExecutor,
  input: { workspaceId: string; name: string; origins: string[] },
): Promise<ApplicationRow> {
  const [row] = await db.insert(applications).values(input).returning(columns)
  if (!row) throw new Error('insert into applications returned no row')
  return row
}

export async function updateApplication(
  db: DbExecutor,
  workspaceId: string,
  applicationId: string,
  changes: { name?: string | undefined; origins?: string[] | undefined },
): Promise<ApplicationRow | undefined> {
  const [row] = await db
    .update(applications)
    .set({
      ...(changes.name !== undefined && { name: changes.name }),
      ...(changes.origins !== undefined && { origins: changes.origins }),
    })
    .where(and(eq(applications.workspaceId, workspaceId), eq(applications.id, applicationId)))
    .returning(columns)
  return row
}

export type DeleteApplicationResult = 'deleted' | 'not-found' | 'has-guides'

/** Guides reference applications with ON DELETE RESTRICT: published history is never lost. */
export async function deleteApplication(
  db: DbExecutor,
  workspaceId: string,
  applicationId: string,
): Promise<DeleteApplicationResult> {
  try {
    const deleted = await db
      .delete(applications)
      .where(and(eq(applications.workspaceId, workspaceId), eq(applications.id, applicationId)))
      .returning({ id: applications.id })
    return deleted.length > 0 ? 'deleted' : 'not-found'
  } catch (error) {
    if (isForeignKeyViolation(error, 'guides_application_fk')) return 'has-guides'
    throw error
  }
}
