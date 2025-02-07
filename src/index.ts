import 'dotenv/config';
import { StateTransitionService } from "./transition";
import { setupLogger } from "./logger";

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

const service = new StateTransitionService(
    STARKNET_RPC,
    STARKNET_PRIVATE_KEY,
    STARKNET_ACCOUNT_ADDRESS,
    VAULT_ADDRESS,
    FOSSIL_API_KEY,
    FOSSIL_API_URL
);

// Run once and exit
service.checkAndTransition()
    .then(() => {
        logger.info("State transition check completed");
        process.exit(0);
    })
    .catch(error => {
        logger.error("Error in state transition check:", error);
        process.exit(1);
    }); 