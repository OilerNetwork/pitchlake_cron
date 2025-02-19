import 'dotenv/config';
import { setupLogger } from "../logger";
import { GasDataService } from './gasData';


async function main() {
  const service = new GasDataService();
  
  try {
    await service.updateTWAPs();
  } catch (error) {
    console.error('Failed to update TWAPs:', error);
  } finally {
    await service.cleanup();
  }
}

main().catch(console.error);