import 'dotenv/config';
import { setupLogger } from "../logger";
import { GasDataService } from './gasData';

const logger = setupLogger();


const service = new GasDataService(
    
);

// Run once and exit
service.updateTWAP()
    .then(() => {
        logger.info("TWAP update completed");
        process.exit(0);
    })
    .catch(error => {
        logger.error("Error in TWAP update:", error);
        process.exit(1);
    });