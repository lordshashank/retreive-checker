import Spark from './lib/spark.js'
import { process } from './vendor/deno-deps.js'
const spark = new Spark()

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down...')
  await spark.cleanup()
})

// Start the event listener and process any pending disputes
try {
  await spark.run()
} catch (error) {
  console.error('Fatal error:', error)
  // Signal error through Zinnia instead of process.exit
  Zinnia.activity.error('Fatal error occurred: ' + error.message)
}
