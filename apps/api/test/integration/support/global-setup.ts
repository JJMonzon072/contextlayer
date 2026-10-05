import { prepareTestDatabase } from './test-database.js'

export default async function setup(): Promise<void> {
  await prepareTestDatabase()
}
