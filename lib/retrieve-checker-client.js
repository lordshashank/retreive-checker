import { ethers } from '../vendor/deno-deps.js'
import { RPC_URL, RETRIEVE_CHECKER_CONTRACT_ADDRESS } from './constants.js'
import { CHECKER_PRIVATE_KEY } from './config.js'

const contractABI = [
  {
    "inputs": [
      {
        "internalType": "enum RetrieveChecker.DisputeStatus",
        "name": "status",
        "type": "uint8"
      }
    ],
    "name": "getDisputesByStatus",
    "outputs": [
      {
        "internalType": "uint256[]",
        "name": "",
        "type": "uint256[]"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "disputeId",
        "type": "uint256"
      }
    ],
    "name": "getDisputeDetails",
    "outputs": [
      {
        "components": [
          {
            "internalType": "uint256",
            "name": "disputeId",
            "type": "uint256"
          },
          {
            "internalType": "address",
            "name": "raiser",
            "type": "address"
          },
          {
            "internalType": "bytes",
            "name": "cid",
            "type": "bytes"
          },
          {
            "internalType": "uint64",
            "name": "spActorId",
            "type": "uint64"
          },
          {
            "internalType": "enum RetrieveChecker.DisputeStatus",
            "name": "status",
            "type": "uint8"
          },
          {
            "internalType": "uint256",
            "name": "timestamp",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "resolutionTimestamp",
            "type": "uint256"
          }
        ],
        "internalType": "struct RetrieveChecker.Dispute",
        "name": "",
        "type": "tuple"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "disputeId",
        "type": "uint256"
      },
      {
        "internalType": "enum RetrieveChecker.DisputeStatus",
        "name": "newStatus",
        "type": "uint8"
      }
    ],
    "name": "resolveDispute",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "disputeId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "raiser",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "bytes",
        "name": "cid",
        "type": "bytes"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "spActorId",
        "type": "uint64"
      }
    ],
    "name": "DisputeRaised",
    "type": "event"
  },
]

// Setup provider
const provider = new ethers.JsonRpcProvider(RPC_URL)
const checkerContract = new ethers.Contract(RETRIEVE_CHECKER_CONTRACT_ADDRESS, contractABI, provider)

/**
 * Get pending disputes from the RetrieveChecker contract
 * @returns {Promise<{id: number, cid: string, minerId: string}[]>} Array of pending disputes
 */
export async function getPendingDisputes({ smartContract } = {}) {
  try {
    const contractClient = smartContract ?? checkerContract
    const PENDING_STATUS = 1 // DisputeStatus.Pending
    const disputeIds = await contractClient.getDisputesByStatus(PENDING_STATUS)

    const disputes = await Promise.all(disputeIds.map(async (id) => {
      const dispute = await contractClient.getDisputeDetails(id)
      let cid = hexHashToCid(dispute.cid)
      // if (cid == "baga6ea4seaqlntvnehlzvb2vmxszckuutkj7f2s52yalzsysrv4rmvvuv4rtwdq") {
      //   cid = "bafybeigvgzoolc3drupxhlevdp2ugqcrbcsqfmcek2zxiw5wctk3xjpjwy"
      // }
      console.log('Dispute details:', dispute)
      console.log('Cid:', cid)
      return {
        id: dispute.disputeId.toString(),
        cid: cid,
        minerId: `f0${dispute.spActorId}`
      }
    }))

    return disputes
  } catch (error) {
    throw Error('Error fetching pending disputes from contract.', { cause: error })
  }
}

/**
 * Submit dispute resolution to the RetrieveChecker contract
 * @param {number} disputeId - The ID of the dispute to resolve
 * @param {object} stats - The retrieval check statistics
 */
export async function submitDisputeResult(disputeId, stats, { smartContract } = {}) {
  try {
    // For write operations, we need a signer
    const privateKey = CHECKER_PRIVATE_KEY
    if (!privateKey) {
      throw new Error('CHECKER_PRIVATE_KEY environment variable must be set')
    }

    const wallet = new ethers.Wallet(privateKey, provider)
    const contractWithSigner = (smartContract ?? checkerContract).connect(wallet)
    
    let newStatus
    if (stats.statusCode === 200) {
      newStatus = 2 // DisputeStatus.Resolved (retrieval successful)
    } else {
      newStatus = 3 // DisputeStatus.Failed (retrieval failed)
    } 
    // configure rejected status for cases check is not executed
    // else {
    //   newStatus = 4 // DisputeStatus.Rejected (invalid check)
    // }

    const tx = await contractWithSigner.resolveDispute(disputeId, newStatus)
    console.log('Submitted dispute resolution transaction:', tx.hash)
    
    const receipt = await tx.wait()
    console.log('Transaction confirmed in block:', receipt.blockNumber)
  } catch (error) {
    throw Error(`Error submitting dispute result for dispute ${disputeId}.`, { cause: error })
  }
}

/**
 * Set up event listener for DisputeRaised events using polling
 * Direct event subscription is probably better but glif was giving me rate limitssssss
 * @param {Function} callback - Function to call when event is received
 * @returns {Function} Cleanup function to remove the listener
 */
export function listenToDisputeRaised(callback) {
    let isListening = true;
    let lastBlock = 0;
    let pollInterval;

    async function pollForEvents() {
        try {
            if (!isListening) return;

            const currentBlock = await provider.getBlockNumber();
            
            if (lastBlock === 0) {
                // On first run, just get current block and wait for new events
                lastBlock = currentBlock;
                return;
            }

            if (currentBlock > lastBlock) {
                console.log(`Checking blocks ${lastBlock + 1} to ${currentBlock} for events...`);
                
                // Get DisputeRaised events
                const filter = checkerContract.filters.DisputeRaised();
                const events = await checkerContract.queryFilter(filter, lastBlock + 1, currentBlock);
                
                // Process events in order
                for (const event of events) {
                    // console.log('Found DisputeRaised event:', event);
                    const [disputeId, raiser, cid, spActorId] = event.args;
                    
                    const dispute = {
                        id: disputeId.toString(),
                        cid: hexHashToCid(cid),
                        minerId: `f0${spActorId}`,
                        raiser
                    };
                    
                    try {
                        await callback(dispute);
                    } catch (error) {
                        console.error('Error processing dispute:', error);
                    }
                }
                
                lastBlock = currentBlock;
            }
        } catch (error) {
            console.error('Error polling for events:', error);
            // Don't update lastBlock on error to retry on next poll
        }
    }

    // Start polling
    console.log('Starting event polling...');
    pollInterval = setInterval(pollForEvents, 12000); // Poll every 12 seconds
    pollForEvents(); // Initial poll

    // Return cleanup function
    return () => {
        console.log('Stopping event polling...');
        isListening = false;
        if (pollInterval) {
            clearInterval(pollInterval);
        }
    };
}

function hexHashToCid(hexHash) {
    // Remove 0x prefix if present
    hexHash = hexHash.replace('0x', '')
    
    // Convert hex to ASCII by taking pairs of characters and converting to characters
    let cid = ''
    for (let i = 0; i < hexHash.length; i += 2) {
        cid += String.fromCharCode(parseInt(hexHash.substr(i, 2), 16))
    }
    return cid
}