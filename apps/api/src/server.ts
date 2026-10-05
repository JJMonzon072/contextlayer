import closeWithGrace from 'close-with-grace'

import { buildApp } from './app.js'
import { ConfigError, loadConfig, type AppConfig } from './config/env.js'
import { createDatabase } from './infrastructure/database/client.js'
import { createLogger } from './logger.js'

function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig()
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`)
      process.exit(1)
    }
    throw error
  }
}

const config = loadConfigOrExit()
const logger = createLogger(config)
const database = createDatabase({ url: config.database.url, logger })
const app = await buildApp({ config, database, logger })

// Drains in-flight requests and the database pool on SIGINT/SIGTERM, and on
// uncaught errors, with a hard deadline so a stuck close never hangs a deploy.
closeWithGrace({ delay: 10_000, logger }, async ({ signal, err }) => {
  if (err) {
    logger.error({ err }, 'closing API after an unexpected error')
  } else {
    logger.info({ signal }, 'shutting down API')
  }
  await app.close()
})

try {
  await app.listen({ host: config.server.host, port: config.server.port })
} catch (error) {
  logger.fatal({ err: error }, 'API failed to start')
  await app.close()
  process.exit(1)
}
