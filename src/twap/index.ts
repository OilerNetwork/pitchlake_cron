import 'dotenv/config';
import { GasDataService } from './gasData';
import cron from 'node-cron';

const service = new GasDataService();

async function main() {
  try {
    console.log('Starting TWAP cron service...');
    
    // Schedule the job to run every 20 seconds
    cron.schedule('*/5 * * * *', async () => {
      console.log(`\nRunning TWAP update job at ${new Date().toISOString()}`);
      try {
        await service.updateTWAPs();
        console.log(`TWAP update job completed at ${new Date().toISOString()}`);
      } catch (error) {
        console.error('Error in TWAP update job:', error);
      }
    });

    // Handle graceful shutdown
    process.on('SIGTERM', async () => {
      console.log('Received SIGTERM signal. Cleaning up...');
      await service.cleanup();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      console.log('Received SIGINT signal. Cleaning up...');
      await service.cleanup();
      process.exit(0);
    });

    console.log('TWAP cron service is running. Press Ctrl+C to exit.');
  } catch (error) {
    console.error('Failed to start TWAP cron service:', error);
    await service.cleanup();
    process.exit(1);
  }
}

main();