/**
 * Main entry point for the application
 */

import { config } from './config.js'
import { logger } from './logger.js'

function main(): void {
  logger.info({ env: config.env }, 'Application starting')
}

main()
