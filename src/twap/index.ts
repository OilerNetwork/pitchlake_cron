import 'dotenv/config';
import { GasDataService } from './gasData';
import cron from 'node-cron';

const service = new GasDataService();
let isJobRunning = false;

async function main() {
  try {
    console.log('Starting TWAP cron service...');
    
    // Schedule the job to run every 20 seconds
    cron.schedule(process.env.CRON_SCHEDULE || '*/20 * * * *', async () => {
      if (isJobRunning) {
        console.log(`Previous job is still running at ${new Date().toISOString()}, skipping this run`);
        return;
      }
      
      console.log(`\nRunning TWAP update job at ${new Date().toISOString()}`);
      isJobRunning = true;
      
      try {
        await service.updateTWAPs();
        console.log(`TWAP update job completed at ${new Date().toISOString()}`);
      } catch (error) {
        console.error('Error in TWAP update job:', error);
      } finally {
        isJobRunning = false;
      }
    });

    // Handle graceful shutdown
    const cleanup = async () => {
      console.log('Shutting down TWAP service...');
      await service.cleanup();
      console.log('Cleanup complete, exiting');
      process.exit(0);
    };

    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
  } catch (error) {
    console.error('Error starting service:', error);
    await service.cleanup();
    process.exit(1);
  }
}

main();