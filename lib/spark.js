/* global Zinnia */

import { ActivityState } from './activity-state.js'
import { SPARK_VERSION, MAX_CAR_SIZE, APPROX_ROUND_LENGTH_IN_MS, MAX_JITTER_BETWEEN_TASKS_IN_MS, MAX_REQUEST_DURATION_MS } from './constants.js'
import { queryTheIndex } from './ipni-client.js'
import { assertOkResponse } from './http-assertions.js'
import { getIndexProviderPeerId as defaultGetIndexProvider } from './miner-info.js'
import { multiaddrToHttpUrl } from './multiaddr.js'
import { getPendingDisputes, submitDisputeResult, listenToDisputeRaised } from './retrieve-checker-client.js'

import {
  CarBlockIterator,
  encodeHex,
  HashMismatchError,
  UnsupportedHashError,
  validateBlock
} from '../vendor/deno-deps.js'

const sleep = dt => new Promise(resolve => setTimeout(resolve, dt))

export default class Spark {
  #fetch
  #getIndexProviderPeerId
  #activity = new ActivityState()
  #cleanup = null
  #processingDisputes = new Set()
  #eventQueue = []
  #processing = false

  constructor ({
    fetch = globalThis.fetch,
    getIndexProviderPeerId = defaultGetIndexProvider
  } = {}) {
    this.#fetch = fetch
    this.#getIndexProviderPeerId = getIndexProviderPeerId
  }

  async #processQueue() {
    if (this.#processing) return;
    this.#processing = true;

    try {
      while (this.#eventQueue.length > 0) {
        const dispute = this.#eventQueue.shift();
        await this.handleDisputeRaised(dispute);
      }
    } finally {
      this.#processing = false;
    }
  }

  async handleDisputeRaised(dispute) {
    // Skip if already processing this dispute
    if (this.#processingDisputes.has(dispute.id)) {
      console.log(`Already processing dispute ${dispute.id}, skipping`);
      return;
    }

    this.#processingDisputes.add(dispute.id);
    console.log('Processing new dispute:', dispute);

    const stats = newStats();
    try {
      await this.executeRetrievalCheck(dispute, stats);
      console.log('Retrieval check stats:', stats);
      
      await submitDisputeResult(dispute.id, stats);
      console.log('Dispute result submitted successfully');
      
      Zinnia.jobCompleted();
      this.#activity.onHealthy();
    } catch (err) {
      this.handleRunError(err);
    } finally {
      this.#processingDisputes.delete(dispute.id);
      // Process next dispute in queue if any
      this.#processQueue();
    }
  }

  async getRetrieval () {
    const disputes = await getPendingDisputes()
    if (!disputes || disputes.length === 0) {
      return null
    }
    // Take the first pending dispute
    const dispute = disputes[0]
    console.log('Processing dispute:', dispute)
    return dispute
  }

  async executeRetrievalCheck (retrieval, stats) {
    console.log(`Calling Filecoin JSON-RPC to get PeerId of miner ${retrieval.minerId}`)
    try {
      const peerId = await this.#getIndexProviderPeerId(retrieval.minerId)
      console.log(`Found peer id: ${peerId}`)
      stats.providerId = peerId
    } catch (err) {
      // There are three common error cases:
      //  1. We are offline
      //  2. The JSON RPC provider is down
      //  3. JSON RPC errors like when Miner ID is not a known actor
      // There isn't much we can do in the first two cases. We can notify the user that we are not
      // performing any jobs and wait until the problem is resolved.
      // The third case should not happen unless we made a mistake, so we want to learn about it
      if (err.name === 'FilecoinRpcError') {
        // TODO: report the error to Sentry
        console.error('The error printed below was not expected, please report it on GitHub:')
        console.error('https://github.com/filecoin-station/spark/issues/new')
      }
      // Abort the check, no measurement should be recorded
      throw err
    }

    console.log(`Querying IPNI to find retrieval providers for ${retrieval.cid}`)
    const { indexerResult, provider } = await queryTheIndex(retrieval.cid, stats.providerId)
    stats.indexerResult = indexerResult

    const providerFound = indexerResult === 'OK' || indexerResult === 'HTTP_NOT_ADVERTISED'
    if (!providerFound) return

    stats.protocol = provider.protocol
    stats.providerAddress = provider.address

    await this.checkCar(provider.protocol, provider.address, retrieval.cid, stats)
    if (stats.protocol === 'http') {
      await this.testHeadRequest(provider.address, retrieval.cid, stats)
    }
  }

  async testHeadRequest (address, cid, stats) {
    const url = getRetrievalUrl('http', address, cid)
    console.log(`Testing HEAD request: ${url}`)
    try {
      const res = await this.#fetch(url, {
        method: 'HEAD',
        headers: {
          Accept: 'application/vnd.ipld.raw'
        },
        signal: AbortSignal.timeout(10_000)
      })
      stats.headStatusCode = res.status
    } catch (err) {
      console.error(`Failed to make HEAD request to ${address} for ${cid}`)
      console.error(err)
      stats.headStatusCode = mapErrorToStatusCode(err)
    }
  }

  async nextRetrieval () {
    const retrieval = await this.getRetrieval()
    if (!retrieval) {
      console.log('No pending disputes found. Waiting for new disputes...')
      return
    }

    const stats = newStats()

    try {
      await this.executeRetrievalCheck(retrieval, stats)
      console.log('Retrieval check stats:', stats)
      
      await submitDisputeResult(retrieval.id, stats)
      console.log('Dispute result submitted successfully')
      
      Zinnia.jobCompleted()
    } catch (err) {
      console.error('Failed to process dispute:', err)
      throw err
    }
  }

  async run() {
    console.log('Starting Spark checker...');
    
    // Set up event listener
    this.#cleanup = listenToDisputeRaised(dispute => {
      console.log('Received new dispute event:', dispute);
      this.#eventQueue.push(dispute);
      this.#processQueue();
    });

    // Process any existing pending disputes first
    try {
      const pendingDisputes = await getPendingDisputes();
      console.log(`Found ${pendingDisputes.length} pending disputes`);
      
      for (const dispute of pendingDisputes) {
        this.#eventQueue.push(dispute);
      }
      this.#processQueue();
    } catch (error) {
      console.error('Error fetching pending disputes:', error);
      this.handleRunError(error);
    }

    // Keep the process running
    return new Promise(() => {
      // Never resolve - keep running until explicitly stopped
    });
  }

  async cleanup() {
    if (this.#cleanup) {
      console.log('Cleaning up Spark checker...');
      this.#cleanup();
      this.#cleanup = null;
    }
  }

  handleRunError (err) {
    if (err.statusCode === 400 && err.serverMessage === 'OUTDATED CLIENT') {
      this.#activity.onOutdatedClient()
    } else {
      this.#activity.onError()
    }
    console.error(err)
  }

  async checkCar(protocol, address, cid, stats, options = {}) {
    const controller = new AbortController()
    const { signal } = controller
    
    let requestIdleTimeout
    const resetTimeout = () => {
      if (requestIdleTimeout) clearTimeout(requestIdleTimeout)
      requestIdleTimeout = setTimeout(() => {
        stats.timeout = true
        controller.abort()
      }, 60_000)
    }

    const maxDurationTimeout = setTimeout(() => {
      stats.timeout = true
      controller.abort()
    }, options.maxRequestDurationMs || MAX_REQUEST_DURATION_MS)

    stats.startAt = new Date()
    stats.fullVerification = true

    try {
      const url = getRetrievalUrl(protocol, address, cid)
      console.log(`[checkCar] Starting full CAR retrieval from: ${url}`)
      console.log(`[checkCar] Protocol: ${protocol}, Address: ${address}, CID: ${cid}`)

      resetTimeout()
      console.log('[checkCar] Initiating fetch request...')
      const res = await this.#fetch(url.replace('?dag-scope=block', ''), { signal })
      stats.statusCode = res.status

      console.log(`[checkCar] Initial response received - Status: ${res.status}, OK: ${res.ok}`)
      console.log('[checkCar] Response headers:', Object.fromEntries(res.headers.entries()))

      if (res.ok) {
        let carData = new Uint8Array(0)
        let chunkCount = 0
        resetTimeout()
        
        console.log('[checkCar] Starting to read response body stream...')
        for await (const chunk of res.body) {
          chunkCount++
          if (stats.firstByteAt === null) {
            stats.firstByteAt = new Date()
            console.log(`[checkCar] First byte received after ${stats.firstByteAt - stats.startAt}ms`)
          }
          
          // Grow buffer to accommodate new chunk
          const newData = new Uint8Array(carData.length + chunk.length)
          newData.set(carData)
          newData.set(chunk, carData.length)
          carData = newData
          
          stats.byteLength += chunk.length
          
          // Note size exceeded but continue downloading
          if (stats.byteLength > MAX_CAR_SIZE && !stats.carTooLarge) {
            stats.carTooLarge = true
            console.log(`[checkCar] Warning: CAR size exceeded ${MAX_CAR_SIZE} bytes, but continuing download`)
          }
          
          console.log(`[checkCar] Chunk ${chunkCount} received: ${chunk.length} bytes. Total: ${stats.byteLength} bytes`)
          resetTimeout()
        }

        if (carData.length > 0) {
          console.log(`[checkCar] Full CAR file received. Total size: ${carData.length} bytes`)
          console.log('[checkCar] Starting CAR validation...')

          try {
            const verificationResult = await verifyContent(cid, carData)
            console.log('[checkCar] Verification result:', verificationResult)

            if (verificationResult.valid) {
              console.log(`[checkCar] File verification successful:`)
              console.log(`- Total blocks: ${verificationResult.totalBlocks}`)
              console.log(`- Total size: ${verificationResult.totalSize} bytes`)
              console.log(`- Root block CID: ${verificationResult.rootBlock.cid}`)
            }

            // Calculate checksum of complete CAR regardless of size
            const digest = await crypto.subtle.digest('sha-256', carData)
            stats.carChecksum = '1220' + encodeHex(digest)
            console.log(`[checkCar] CAR file checksum: ${stats.carChecksum}`)

          } catch (parsingError) {
            console.error('[checkCar] CAR parsing/validation failed:', {
              error: parsingError.message,
              stack: parsingError.stack,
              code: parsingError.code,
              dataSize: carData.length,
              firstBytes: encodeHex(carData.slice(0, 32)) // Show first 32 bytes for debugging
            })
            throw parsingError
          }
        } else {
          console.error('[checkCar] Error: Received empty CAR file')
          throw new Error('Received empty CAR file')
        }
      } else {
        const responseText = await res.text()
        console.error('[checkCar] Full CAR retrieval failed:', {
          statusCode: res.status,
          statusText: res.statusText,
          responseBody: responseText.trimEnd(),
          headers: Object.fromEntries(res.headers.entries())
        })
      }
    } catch (err) {
      console.error('[checkCar] Critical error during CAR retrieval/validation:', {
        error: err.message,
        code: err.code,
        name: err.name,
        stack: err.stack,
        protocol,
        address,
        cid,
        stats: {
          byteLength: stats.byteLength,
          timeout: stats.timeout,
          statusCode: stats.statusCode,
          duration: stats.firstByteAt ? (new Date() - stats.firstByteAt) : null
        }
      })
      
      if (!stats.statusCode || stats.statusCode === 200) {
        stats.statusCode = mapErrorToStatusCode(err)
        console.log(`[checkCar] Mapped error to status code: ${stats.statusCode}`)
      }
    } finally {
      clearTimeout(requestIdleTimeout)
      clearTimeout(maxDurationTimeout)
      console.log('[checkCar] Operation completed:', {
        duration: new Date() - stats.startAt,
        bytesReceived: stats.byteLength,
        statusCode: stats.statusCode,
        timeout: stats.timeout,
        checksum: stats.carChecksum,
        exceededMaxSize: stats.carTooLarge
      })
    }

    stats.endAt = new Date()
  }
}

/**
 * @param {object} args
 * @param {number} args.roundLengthInMs
 * @param {number} [args.maxJitterInMs=0]
 * @param {number} args.maxTasksPerRound
 * @param {number} args.lastTaskDurationInMs
 */
export function calculateDelayBeforeNextTask ({
  roundLengthInMs,
  maxJitterInMs = 0,
  maxTasksPerRound,
  lastTaskDurationInMs
}) {
  const baseDelay = roundLengthInMs / maxTasksPerRound
  const delay = baseDelay - lastTaskDurationInMs
  const base = Math.min(delay, 60_000)

  // Introduce some jitter to avoid all clients querying cid.contact at the same time
  const jitter = Math.round(Math.random() * maxJitterInMs)

  return base + jitter
}

export function newStats () {
  return {
    timeout: false,
    startAt: null,
    firstByteAt: null,
    endAt: null,
    carTooLarge: false,
    byteLength: 0,
    carChecksum: null,
    statusCode: null,
    headStatusCode: null
  }
}

export function getRetrievalUrl (protocol, address, cid) {
  if (protocol === 'http') {
    const baseUrl = multiaddrToHttpUrl(address)
    // For HTTP, we still use block scope
    return `${baseUrl}/ipfs/${cid}?dag-scope=block`
  }

  const searchParams = new URLSearchParams({
    // For graphsync, don't limit scope to get full file
    protocols: protocol,
    providers: address
  })
  return `ipfs://${cid}?${searchParams.toString()}`
}

/**
 * @param {string} cid
 * @param {Uint8Array} carBytes
 */
async function verifyContent(cid, carBytes) {
  let reader
  try {
    reader = await CarBlockIterator.fromBytes(carBytes)
  } catch (err) {
    throw Object.assign(err, { code: 'CANNOT_PARSE_CAR_BYTES' })
  }

  // First pass: collect all blocks and validate them individually
  const blocks = new Map()
  for await (const block of reader) {
    try {
      await validateBlock(block)
      blocks.set(block.cid.toString(), block)
    } catch (err) {
      throw Object.assign(err, { 
        code: err.code || 'BLOCK_VALIDATION_FAILED',
        blockCid: block.cid.toString() 
      })
    }
  }

  // Find our target block
  let targetBlock = blocks.get(cid)
  if (!targetBlock) {
    // If not found directly, this might be a file CID, traverse the DAG
    console.log(`[verifyContent] Target CID ${cid} not found directly, traversing DAG...`)
    
    // Log all found blocks for debugging
    console.log('[verifyContent] Found blocks:', Array.from(blocks.keys()))

    let foundValidDag = false
    for (const [blockCid, block] of blocks) {
      try {
        const decoded = decode(block.bytes)
        if (decoded.Links && decoded.Links.length > 0) {
          // This is a directory/file block, verify its structure
          const allLinksPresent = decoded.Links.every(link => 
            blocks.has(link.Hash.toString())
          )
          if (allLinksPresent) {
            console.log(`[verifyContent] Found valid DAG structure in block ${blockCid}`)
            foundValidDag = true
            targetBlock = block
            break
          }
        }
      } catch (err) {
        console.log(`[verifyContent] Failed to decode block ${blockCid}:`, err.message)
        // Continue checking other blocks
      }
    }

    if (!foundValidDag) {
      throw Object.assign(
        new Error(`Could not verify complete file structure for CID ${cid}`),
        { code: 'INCOMPLETE_DAG' }
      )
    }
  }

  // At this point we have either found the exact CID block or a valid DAG structure
  return {
    valid: true,
    rootBlock: targetBlock,
    totalBlocks: blocks.size,
    totalSize: Array.from(blocks.values()).reduce((sum, b) => sum + b.bytes.length, 0)
  }
}

function mapErrorToStatusCode (err) {
  // 7xx codes for multiaddr parsing errors
  switch (err.code) {
    case 'UNSUPPORTED_MULTIADDR_HOST_TYPE':
      return 701
    case 'UNSUPPORTED_MULTIADDR_PROTO':
      return 702
    case 'UNSUPPORTED_MULTIADDR_SCHEME':
      return 703
    case 'MULTIADDR_HAS_TOO_MANY_PARTS':
      return 704
    case 'INVALID_HTTP_PATH':
      return 705
  }

  // 9xx for content verification errors
  if (err instanceof UnsupportedHashError) {
    return 901
  } else if (err instanceof HashMismatchError) {
    return 902
  } else if (err.code === 'UNEXPECTED_CAR_BLOCK') {
    return 903
  } else if (err.code === 'CANNOT_PARSE_CAR_BYTES') {
    return 904
  }

  // 8xx errors for network connection errors
  // Unfortunately, the Fetch API does not support programmatic detection of various error
  // conditions. We have to check the error message text.
  if (err.message.includes('dns error')) {
    return 801
  } else if (err.message.includes('tcp connect error')) {
    return 802
  }

  // Fallback code for unknown errors
  return 600
}
