import { Client } from "pg";
import { formatUnits } from "ethers";
import { BlockTWAPData, FormattedBlockData, RawBlockData } from "../types";

// Time ranges in seconds
export const TWAP_RANGES = {
  TWELVE_MIN: 12 * 60, // 12 minutes
  THREE_HOURS: 3 * 60 * 60, // 3 hours
  THIRTY_DAYS: 30 * 24 * 60 * 60, // 30 days
} as const;

export class GasDataService {
  private fossilClient: Client;
  private pitchlakeClient: Client;
  constructor() {
    this.fossilClient = new Client({
      connectionString: process.env.DATABASE_URL,
    });
    this.fossilClient.connect();
    this.pitchlakeClient = new Client({
      connectionString: process.env.PITCHLAKE_DATABASE_URL,
    });
    this.pitchlakeClient.connect();
  }
  async getLastBlock(): Promise<FormattedBlockData> {
    //get the last block from pitchlake db
    const query = `SELECT * FROM blocks ORDER BY timestamp DESC LIMIT 1`;
    const result = await this.pitchlakeClient.query(query);
    return result.rows[0];
  }
  async updateTWAP(): Promise<void> {
    const lastBlock = await this.getLastBlock();
    const rawData = await this.getGasData(lastBlock);
    const formattedData = await this.formatGasData(rawData);
    const twapData = await this.getTWAPs(formattedData);

    // Insert all blocks with their TWAP data
    const insertQuery = `
      INSERT INTO blocks (
        block_number, 
        timestamp, 
        basefee, 
        twelvemin_weighted_sum, 
        twelvemin_total_seconds, 
        twelvemin_twap, 
        threehour_weighted_sum, 
        threehour_total_seconds, 
        threehour_twap, 
        thirtyday_weighted_sum, 
        thirtyday_total_seconds, 
        thirtyday_twap
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `;

    // Insert each block's data
    await Promise.all(twapData.map(block => {
      if (!block.blockNumber || !block.basefee) return Promise.resolve();
      
      return this.pitchlakeClient.query(insertQuery, [
        block.blockNumber,
        block.timestamp,
        block.basefee,
        block.twelveminTwap?.weightedSum,
        block.twelveminTwap?.totalSeconds,
        block.twelveminTwap?.twapValue,
        block.threeHourTwap?.weightedSum,
        block.threeHourTwap?.totalSeconds,
        block.threeHourTwap?.twapValue,
        block.thirtyDayTwap?.weightedSum,
        block.thirtyDayTwap?.totalSeconds,
        block.thirtyDayTwap?.twapValue
      ]);
    }));

    await this.fossilClient.end();
    await this.pitchlakeClient.end();
  }
  async getGasData(lastBlock: FormattedBlockData): Promise<RawBlockData[]> {
    //all headers greater than the last block, limit to 300 rows
    const query = `
    SELECT * FROM blockheaders WHERE timestamp > $1
    LIMIT 300
    `;
    const result = await this.fossilClient.query(query, [lastBlock.timestamp]);
    return result.rows.map((r: any) => ({
      block_number: r.block_number || undefined,
      base_fee_per_gas: r.base_fee_per_gas || undefined,
      timestamp: Number(r.timestamp),
    }));
  }
  async formatGasData(rawData: RawBlockData[]): Promise<FormattedBlockData[]> {
    let sortedData = rawData.sort((a, b) => a.timestamp - b.timestamp);

    // Convert base_fee_per_gas to gwei
    const formattedData: FormattedBlockData[] = sortedData.map((r) => ({
      blockNumber: r.block_number ? r.block_number : 0,
      timestamp: r.timestamp ? r.timestamp : 0,
      basefee: r.base_fee_per_gas
        ? Number(formatUnits(parseInt(r.base_fee_per_gas), "gwei"))
        : 0,
    }));
    return formattedData;
  }
  async getTWAPs(
    blockData: FormattedBlockData[]
  ): Promise<(FormattedBlockData & Partial<BlockTWAPData>)[]> {
    if (!blockData?.length) {
      return [];
    }

    // Sort blocks by timestamp to ensure correct order
    const sortedBlocks = [...blockData].sort((a, b) => a.timestamp - b.timestamp);

    // Get the last block from DB to initialize our state
    const lastBlockFromDB = await this.getLastBlock();
    if (!lastBlockFromDB) {
      // If no last block, we're starting fresh
      return [];
    }

    // Get the full TWAP data for the last block
    const lastBlockTWAP = await this.fetchBlockTWAPData(lastBlockFromDB.blockNumber!);
    if (!lastBlockTWAP) {
      return [];
    }

    let currentState = {
      twelveminTwap: { ...lastBlockTWAP.twelveminTwap! },
      threeHourTwap: { ...lastBlockTWAP.threeHourTwap! },
      thirtyDayTwap: { ...lastBlockTWAP.thirtyDayTwap! }
    };

    // Process each block and return the array of results
    return await Promise.all(sortedBlocks.map(async (currentBlock) => {
      if (!currentBlock.blockNumber || !currentBlock.basefee) {
        return currentBlock;
      }

      const currentTime = currentBlock.timestamp;

      // For 12 min window
      const twelveMinWindowStart = currentTime - TWAP_RANGES.TWELVE_MIN;
      const oldTwelveMinQuery = `
        SELECT * FROM blocks 
        WHERE timestamp <= $1 OR timestamp >= $2
        ORDER BY timestamp ASC
        LIMIT 1`;
      const oldTwelveMinBlock = await this.pitchlakeClient.query(oldTwelveMinQuery, [
        twelveMinWindowStart,
        twelveMinWindowStart - 12
      ]);
      if (oldTwelveMinBlock.rows.length > 0) {
        const oldBlock = oldTwelveMinBlock.rows[0];
        const duration = Math.min(
          TWAP_RANGES.TWELVE_MIN,
          oldBlock.timestamp - (twelveMinWindowStart - TWAP_RANGES.TWELVE_MIN)
        );
        currentState.twelveminTwap.weightedSum -= oldBlock.basefee * duration;
        currentState.twelveminTwap.totalSeconds -= duration;
      }

      // For 3 hour window
      const threeHourWindowStart = currentTime - TWAP_RANGES.THREE_HOURS;
      const oldThreeHourQuery = `
        SELECT * FROM blocks 
        WHERE timestamp <= $1 OR timestamp >= $2
        ORDER BY timestamp ASC
        LIMIT 1`;
      const oldThreeHourBlock = await this.pitchlakeClient.query(oldThreeHourQuery, [
        threeHourWindowStart,
        threeHourWindowStart - 12
      ]);
      if (oldThreeHourBlock.rows.length > 0) {
        const oldBlock = oldThreeHourBlock.rows[0];
        const duration = Math.min(
          TWAP_RANGES.THREE_HOURS,
          oldBlock.timestamp - (threeHourWindowStart - TWAP_RANGES.THREE_HOURS)
        );
        currentState.threeHourTwap.weightedSum -= oldBlock.basefee * duration;
        currentState.threeHourTwap.totalSeconds -= duration;
      }

      // For 30 day window
      const thirtyDayWindowStart = currentTime - TWAP_RANGES.THIRTY_DAYS;
      const oldThirtyDayQuery = `
        SELECT * FROM blocks 
        WHERE timestamp <= $1 OR timestamp >= $2
        ORDER BY timestamp ASC
        LIMIT 1`;
      const oldThirtyDayBlock = await this.pitchlakeClient.query(oldThirtyDayQuery, [
        thirtyDayWindowStart,
        thirtyDayWindowStart - 12
      ]);
      if (oldThirtyDayBlock.rows.length > 0) {
        const oldBlock = oldThirtyDayBlock.rows[0];
        const duration = Math.min(
          TWAP_RANGES.THIRTY_DAYS,
          oldBlock.timestamp - (thirtyDayWindowStart - TWAP_RANGES.THIRTY_DAYS)
        );
        currentState.thirtyDayTwap.weightedSum -= oldBlock.basefee * duration;
        currentState.thirtyDayTwap.totalSeconds -= duration;
      }

      // Add current block's contribution to each window
      // For 12 min window
      const twelveMinDuration = Math.min(TWAP_RANGES.TWELVE_MIN, currentTime - lastBlockFromDB.timestamp);
      currentState.twelveminTwap.weightedSum += currentBlock.basefee * twelveMinDuration;
      currentState.twelveminTwap.totalSeconds += twelveMinDuration;
      currentState.twelveminTwap.twapValue = 
        currentState.twelveminTwap.weightedSum / currentState.twelveminTwap.totalSeconds;

      // For 3 hour window
      const threeHourDuration = Math.min(TWAP_RANGES.THREE_HOURS, currentTime - lastBlockFromDB.timestamp);
      currentState.threeHourTwap.weightedSum += currentBlock.basefee * threeHourDuration;
      currentState.threeHourTwap.totalSeconds += threeHourDuration;
      currentState.threeHourTwap.twapValue = 
        currentState.threeHourTwap.weightedSum / currentState.threeHourTwap.totalSeconds;

      // For 30 day window
      const thirtyDayDuration = Math.min(TWAP_RANGES.THIRTY_DAYS, currentTime - lastBlockFromDB.timestamp);
      currentState.thirtyDayTwap.weightedSum += currentBlock.basefee * thirtyDayDuration;
      currentState.thirtyDayTwap.totalSeconds += thirtyDayDuration;
      currentState.thirtyDayTwap.twapValue = 
        currentState.thirtyDayTwap.weightedSum / currentState.thirtyDayTwap.totalSeconds;

      // Create result with current state
      return {
        ...currentBlock,
        twelveminTwap: { ...currentState.twelveminTwap },
        threeHourTwap: { ...currentState.threeHourTwap },
        thirtyDayTwap: { ...currentState.thirtyDayTwap }
      };
    }));
  }
  async fetchBlockTWAPData(blockNumber: number): Promise<BlockTWAPData | null> {
    const query = `
      SELECT 
        block_number,
        timestamp,
        basefee,
        twelvemin_weighted_sum,
        twelvemin_total_seconds,
        twelvemin_twap,
        threehour_weighted_sum,
        threehour_total_seconds,
        threehour_twap,
        thirtyday_weighted_sum,
        thirtyday_total_seconds,
        thirtyday_twap
      FROM blocks 
      WHERE block_number = $1;
    `;

    try {
      const result = await this.pitchlakeClient.query(query, [blockNumber]);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];

      return {
        blockNumber: row.block_number,
        timestamp: row.timestamp,
        basefee: row.basefee,
        twelveminTwap: {
          weightedSum: row.twelvemin_weighted_sum,
          totalSeconds: row.twelvemin_total_seconds,
          twapValue: row.twelvemin_twap,
        },
        threeHourTwap: {
          weightedSum: row.threehour_weighted_sum,
          totalSeconds: row.threehour_total_seconds,
          twapValue: row.threehour_twap,
        },
        thirtyDayTwap: {
          weightedSum: row.thirtyday_weighted_sum,
          totalSeconds: row.thirtyday_total_seconds,
          twapValue: row.thirtyday_twap,
        },
      };
    } catch (error) {
      console.error("Error fetching block TWAP data:", error);
      throw error;
    }
  }
}
