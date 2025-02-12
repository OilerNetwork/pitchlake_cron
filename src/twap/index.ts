import 'dotenv/config';
import { StateTransitionService } from "../transition";
import { setupLogger } from "../logger";
import { GasDataService } from './gasData';

const logger = setupLogger();

// Load environment variables
const {
    STARKNET_RPC,
    STARKNET_PRIVATE_KEY,
    STARKNET_ACCOUNT_ADDRESS,
    VAULT_ADDRESS,
    FOSSIL_API_KEY,
    FOSSIL_API_URL
} = process.env;

// Validate environment variables
if (!STARKNET_RPC || !STARKNET_PRIVATE_KEY || !STARKNET_ACCOUNT_ADDRESS || !VAULT_ADDRESS || !FOSSIL_API_KEY || !FOSSIL_API_URL) {
    logger.error("Missing required environment variables");
    process.exit(1);
}

const service = new GasDataService(
    
);

// Run once and exit
service.updateTWAP()
    .then(() => {
        logger.info("State transition check completed");
        process.exit(0);
    })
    .catch(error => {
        logger.error("Error in state transition check:", error);
        process.exit(1);
    });