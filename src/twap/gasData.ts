import { Client,Pool } from "pg";
import { demoBlocks } from "./demoData";
import {
  FormattedBlockData,
  TWAPWindowType,
  TWAPState,
  BlockWithNextTimestamp,
  TWAPStateContainer,
} from "../types";
import * as fs from "fs";
import * as path from "path";

// Time ranges in seconds
export const TWAP_RANGES = {
  TWELVE_MIN: 12 * 60, // 12 minutes
  THREE_HOURS: 3 * 60 * 60, // 3 hours
  THIRTY_DAYS: 30 * 24 * 60 * 60, // 30 days
} as const;

export class GasDataService {
  private fossilClient?: Client;
  private pitchlakeClient?: Client;

  constructor() {
  
  }

  private readonly WINDOW_CONFIGS = [
    {
      type: "twelve_min" as TWAPWindowType,
      duration: TWAP_RANGES.TWELVE_MIN,
      stateKey: "twelveminTwap" as const,
    },
    {
      type: "three_hour" as TWAPWindowType,
      duration: TWAP_RANGES.THREE_HOURS,
      stateKey: "threeHourTwap" as const,
    },
    {
      type: "thirty_day" as TWAPWindowType,
      duration: TWAP_RANGES.THIRTY_DAYS,
      stateKey: "thirtyDayTwap" as const,
    },
  ];

  // Database operations
  private async getTWAPState(
    windowType: TWAPWindowType
  ): Promise<TWAPState | null> {
    if (process.env.USE_DEMO_DATA === 'true') {
      return null;
    }

    const query = `
      SELECT weighted_sum, total_seconds, twap_value, last_block_number, last_block_timestamp
      FROM twap_state
      WHERE window_type = $1
      AND is_confirmed = true
      FOR UPDATE
    `;

    try {
      const result = await this.pitchlakeClient?.query(query, [windowType]);
      if (!result || result.rows.length === 0) return null;

      const row = result.rows[0];
      return {
        weightedSum: Number(row.weighted_sum),
        totalSeconds: Number(row.total_seconds),
        twapValue: Number(row.twap_value),
        lastBlockNumber: Number(row.last_block_number),
        lastBlockTimestamp: Number(row.last_block_timestamp),
      };
    } catch (error) {
      console.error(`Error fetching TWAP state for ${windowType}:`, error);
      throw error;
    }
  }

  private async saveTWAPState(
    windowType: TWAPWindowType,
    state: TWAPState
  ): Promise<void> {
    if (process.env.USE_DEMO_DATA === 'true') {
      return;
    }

    const query = `
      INSERT INTO twap_state (
        window_type, weighted_sum, total_seconds, twap_value, 
        last_block_number, last_block_timestamp, is_confirmed
      ) 
      VALUES ($1, $2, $3, $4, $5, $6, true)
      ON CONFLICT ON CONSTRAINT twap_state_window_type_is_confirmed_key
      DO UPDATE SET 
        weighted_sum = $2,
        total_seconds = $3,
        twap_value = $4,
        last_block_number = $5,
        last_block_timestamp = $6
    `;

    try {
      const result = await this.pitchlakeClient?.query(query, [
        windowType,
        state.weightedSum,
        state.totalSeconds,
        state.twapValue,
        state.lastBlockNumber,
        state.lastBlockTimestamp,
      ]);
      if (!result && process.env.USE_DEMO_DATA !== 'true') {
        throw new Error('Failed to save TWAP state');
      }
    } catch (error) {
      console.error(`Error saving TWAP state for ${windowType}:`, error);
      throw error;
    }
  }

  private async fetchRelevantBlocks(
    oldestTimestamp: number,
    newestTimestamp: number
  ): Promise<BlockWithNextTimestamp[]> {
    if (process.env.USE_DEMO_DATA === 'true') {
      // For demo mode, construct block history from demo data
      // Include enough history for all window sizes
      const minTimestamp = Math.min(
        oldestTimestamp - TWAP_RANGES.THIRTY_DAYS,
        newestTimestamp - TWAP_RANGES.THIRTY_DAYS
      );
      
      const relevantBlocks = demoBlocks
        .filter(block => 
          block.timestamp >= minTimestamp &&
          block.timestamp <= newestTimestamp
        )
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((block, index, array) => ({
          timestamp: block.timestamp,
          next_timestamp: index < array.length - 1 ? array[index + 1].timestamp : null,
          basefee: block.basefee || 0
        }));

      if (relevantBlocks.length === 0) {
        console.warn('No relevant blocks found in demo data for the specified time range');
      }

      return relevantBlocks;
    }

    const query = `
      WITH time_windows AS (
        SELECT 
          timestamp::numeric,
          LEAD(timestamp::numeric) OVER (ORDER BY timestamp ASC) as next_timestamp,
          basefee::numeric
        FROM blocks
        WHERE timestamp >= ($1::numeric - $4::numeric)  -- 30 days before oldest block
          AND timestamp <= $2::numeric       -- newest block
      )
      SELECT 
        timestamp,
        next_timestamp,
        basefee
      FROM time_windows
      WHERE timestamp <= $2::numeric
        AND (
          timestamp >= ($2::numeric - $3::numeric) OR  -- 12 min window
          timestamp >= ($2::numeric - $4::numeric) OR  -- 3 hour window
          timestamp >= ($2::numeric - $5::numeric)     -- 30 day window
        )
      ORDER BY timestamp DESC
    `;

    const result = await this.pitchlakeClient?.query(query, [
      oldestTimestamp,
      newestTimestamp,
      TWAP_RANGES.TWELVE_MIN,
      TWAP_RANGES.THREE_HOURS,
      TWAP_RANGES.THIRTY_DAYS,
    ]);

    if (!result && process.env.USE_DEMO_DATA !== 'true') {
      throw new Error('Failed to fetch relevant blocks');
    }

    return result?.rows || [];
  }

  // TWAP calculation
  private calculateTWAP(
    state: TWAPState,
    windowSize: number,
    windowStart: number,
    currentBlock: FormattedBlockData,
    relevantBlocks: BlockWithNextTimestamp[]
  ): TWAPState {
    let newState = { ...state };

    // Sort blocks by timestamp ascending to ensure correct order
    const sortedBlocks = [...relevantBlocks]
      .sort((a, b) => a.timestamp - b.timestamp);

    // Get all blocks that fall within our window
    const blocksInWindow = sortedBlocks.filter(
      (block) =>
        block.timestamp <= currentBlock.timestamp &&
        block.timestamp > windowStart &&
        block.next_timestamp // only include blocks with known duration
    );

    // If there's no history, use 0
    if (blocksInWindow.length === 0) {
      newState.weightedSum = 0;
      newState.totalSeconds = windowSize;
      newState.twapValue = 0;
      newState.lastBlockNumber = currentBlock.blockNumber || 0;
      newState.lastBlockTimestamp = currentBlock.timestamp;
      return newState;
    }

    // Reset the weighted sum for this window
    newState.weightedSum = 0;
    
    // Calculate the actual window coverage
    // Window can't start before the first block or end after the current block
    const effectiveWindowStart = Math.max(windowStart, blocksInWindow[0].timestamp);
    const effectiveWindowEnd = currentBlock.timestamp;
    newState.totalSeconds = effectiveWindowEnd - effectiveWindowStart;

    // Calculate contribution of each block in the window
    for (let i = 0; i < blocksInWindow.length; i++) {
      const block = blocksInWindow[i];
      const nextBlock = i < blocksInWindow.length - 1 ? blocksInWindow[i + 1] : currentBlock;
      
      const blockStart = Math.max(block.timestamp, effectiveWindowStart);
      const blockEnd = Math.min(nextBlock.timestamp, effectiveWindowEnd);
      const duration = blockEnd - blockStart;
      
      if (duration > 0) {
        newState.weightedSum += block.basefee * duration;
      }
    }

    // Calculate TWAP
    newState.twapValue = newState.totalSeconds > 0 
      ? newState.weightedSum / newState.totalSeconds 
      : 0;

    newState.lastBlockNumber = currentBlock.blockNumber || 0;
    newState.lastBlockTimestamp = currentBlock.timestamp;

    return newState;
  }

  private initializeTWAPState(
    states: (TWAPState | null)[]
  ): TWAPStateContainer {
    return {
      twelveminTwap: states[0] || {
        weightedSum: 0,
        totalSeconds: 0,
        twapValue: 0,
        lastBlockNumber: 0,
        lastBlockTimestamp: 0,
      },
      threeHourTwap: states[1] || {
        weightedSum: 0,
        totalSeconds: 0,
        twapValue: 0,
        lastBlockNumber: 0,
        lastBlockTimestamp: 0,
      },
      thirtyDayTwap: states[2] || {
        weightedSum: 0,
        totalSeconds: 0,
        twapValue: 0,
        lastBlockNumber: 0,
        lastBlockTimestamp: 0,
      },
    };
  }

  private async storeNewBlocks(blocks: FormattedBlockData[]): Promise<void> {
    if (!blocks.length) return;

    const query = `
      INSERT INTO blocks (block_number, timestamp, basefee, is_confirmed)
      VALUES ($1, $2, $3, false)
      ON CONFLICT (block_number) 
      DO UPDATE SET 
        basefee = $3,
        is_confirmed = true
    `;

    await Promise.all(
      blocks.map((block) =>
        this.pitchlakeClient?.query(query, [
          block.blockNumber,
          block.timestamp,
          block.basefee,
        ])
      )
    );
  }

  private async updateBlockTWAPs(
    block_number: number,
    twelve_min_twap: number,
    three_hour_twap: number,
    thirty_day_twap: number
  ): Promise<void> {
    const query = `
      UPDATE blocks 
      SET twelve_min_twap = $2,
          three_hour_twap = $3,
          thirty_day_twap = $4,
          is_confirmed = true
      WHERE block_number = $1
    `;

    try {
      await this.pitchlakeClient?.query(query, [
        block_number,
        twelve_min_twap,
        three_hour_twap,
        thirty_day_twap
      ]);
    } catch (error) {
      console.error(`Error updating TWAPs for block ${block_number}:`, error);
      throw error;
    }
  }

  private async getTWAPs(blockData: FormattedBlockData[]): Promise<void> {
    if (!blockData?.length) return;

    try {
      if (process.env.USE_DEMO_DATA !== 'true') {
        await this.pitchlakeClient?.query("BEGIN");
        // First store the new blocks
        await this.storeNewBlocks(blockData);
      }

      // Sort blocks by timestamp and remove any blocks with undefined basefee
      const sortedBlocks = [...blockData]
        .filter(block => block.blockNumber != null && block.basefee != null)
        .sort((a, b) => a.timestamp - b.timestamp);

      if (sortedBlocks.length === 0) {
        console.log("No valid blocks to process after filtering");
        return;
      }

      const oldestTimestamp = sortedBlocks[0].timestamp;
      const newestTimestamp = sortedBlocks[sortedBlocks.length - 1].timestamp;

      // Fetch all necessary data
      const [states, relevantBlocks] = await Promise.all([
        Promise.all(
          this.WINDOW_CONFIGS.map((config) => this.getTWAPState(config.type))
        ),
        this.fetchRelevantBlocks(oldestTimestamp, newestTimestamp),
      ]);

      if (relevantBlocks.length === 0) {
        console.log("No relevant blocks found for TWAP calculation");
        return;
      }

      let currentState = this.initializeTWAPState(states);
      
      // For demo mode: store all block TWAPs
      const blockTWAPs: {
        block_number: number;
        timestamp: number;
        basefee: number;
        twelve_min_twap: number;
        three_hour_twap: number;
        thirty_day_twap: number;
      }[] = [];

      // Process each block
      for (const currentBlock of sortedBlocks) {
        // Skip TWAP updates for the latest block
        const isLatestBlock = !relevantBlocks.some(
          (block) => block.timestamp > currentBlock.timestamp
        );
        if (isLatestBlock) {
          console.log(`Skipping latest block ${currentBlock.blockNumber} for TWAP updates`);
          continue;
        }

        // Update TWAPs for each time window
        this.WINDOW_CONFIGS.forEach((config) => {
          currentState[config.stateKey] = this.calculateTWAP(
            currentState[config.stateKey],
            config.duration,
            currentBlock.timestamp - config.duration,
            currentBlock,
            relevantBlocks
          );
        });

        const blockTWAPData = {
          block_number: currentBlock.blockNumber!,
          timestamp: currentBlock.timestamp,
          basefee: currentBlock.basefee!,
          twelve_min_twap: currentState.twelveminTwap.twapValue,
          three_hour_twap: currentState.threeHourTwap.twapValue,
          thirty_day_twap: currentState.thirtyDayTwap.twapValue
        };

        if (process.env.USE_DEMO_DATA === 'true') {
          blockTWAPs.push(blockTWAPData);
        } else {
          await this.updateBlockTWAPs(
            blockTWAPData.block_number,
            blockTWAPData.twelve_min_twap,
            blockTWAPData.three_hour_twap,
            blockTWAPData.thirty_day_twap
          );
        }
      }

      if (process.env.USE_DEMO_DATA === 'true') {
        // Save detailed block TWAPs to file
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const outputPath = path.join(process.cwd(), 'demo_outputs', `twap_calculations_${timestamp}.json`);
        
        const output = {
          metadata: {
            totalBlocks: blockTWAPs.length,
            timeRange: {
              start: oldestTimestamp,
              end: newestTimestamp
            }
          },
          twap_state: Object.fromEntries(
            this.WINDOW_CONFIGS.map(config => [
              config.type,
              {
                window_type: config.type,
                weighted_sum: currentState[config.stateKey].weightedSum,
                total_seconds: currentState[config.stateKey].totalSeconds,
                twap_value: currentState[config.stateKey].twapValue,
                last_block_number: currentState[config.stateKey].lastBlockNumber,
                last_block_timestamp: currentState[config.stateKey].lastBlockTimestamp,
              }
            ])
          ),
          blocks: blockTWAPs
        };

        fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
        console.log(`Demo Mode - Saved TWAP calculations to ${outputPath}`);
        
        // Also log final states to console as before
        console.log('Demo Mode - Final TWAP States:');
        this.WINDOW_CONFIGS.forEach(config => {
          console.log(`${config.type}:`, currentState[config.stateKey]);
        });
      } else {
        // Save final states to database
        await Promise.all(
          this.WINDOW_CONFIGS.map((config) =>
            this.saveTWAPState(config.type, currentState[config.stateKey])
          )
        );
        await this.pitchlakeClient?.query("COMMIT");
      }
    } catch (error) {
      if (process.env.USE_DEMO_DATA !== 'true') {
        await this.pitchlakeClient?.query("ROLLBACK");
      }
      console.error("Error in getTWAPs transaction:", error);
      throw error;
    }
  }

  private async getNewBlocks(
    lastProcessedBlock: number
  ): Promise<FormattedBlockData[]> {
    console.log("TRIED")
    if (process.env.USE_DEMO_DATA === 'true') {
      // Filter demo blocks based on lastProcessedTimestamp
      return demoBlocks
        .filter(block => block.blockNumber > lastProcessedBlock)
        .sort((a, b) => a.timestamp - b.timestamp);
    }

    const query = `
      SELECT number, timestamp, base_fee_per_gas
      FROM blockheaders 
      WHERE number > $1
      AND base_fee_per_gas IS NOT NULL
      ORDER BY number ASC
      LIMIT 300
    `;

    const result = await this.fossilClient?.query(query, [lastProcessedBlock]);
    

    console.log("RESULT",result)
    if (!result && process.env.USE_DEMO_DATA !== 'true') {
      throw new Error('Failed to fetch new blocks');
    }

    return (result?.rows || []).map((row) => ({
      blockNumber: row.number,
      timestamp: Number(row.timestamp),
      basefee: row.base_fee_per_gas ? Number(row.base_fee_per_gas) : undefined,
    }));
  }
  public async updateTWAPs(): Promise<void> {
    console.log("REACHED HERE")
    if (process.env.USE_DEMO_DATA !== 'true') {
      this.fossilClient = new Client({
        host: process.env.FOSSIL_DB_HOST,
        port: Number(process.env.FOSSIL_DB_PORT),
        database: process.env.FOSSIL_DB_NAME,
        user: process.env.FOSSIL_DB_USER,
        password: process.env.FOSSIL_DB_PASSWORD,
        ssl: {
          rejectUnauthorized: false
        }
      });
      await this.fossilClient.connect();
      this.pitchlakeClient = new Client({
        host: process.env.PITCHLAKE_DB_HOST,
        port: Number(process.env.PITCHLAKE_DB_PORT),
        database: process.env.PITCHLAKE_DB_NAME,
        user: process.env.PITCHLAKE_DB_USER,
        password: process.env.PITCHLAKE_DB_PASSWORD,
        ssl: false
      });
      await this.pitchlakeClient.connect();
    }
    try {
      if (process.env.USE_DEMO_DATA === 'true') {
        console.log('Running in demo mode with sample data');
      }

      // Get the last processed confirmed block from any TWAP state
      const lastState =
        process.env.USE_DEMO_DATA === "true"
          ? undefined
          : await this.getTWAPState("twelve_min");
      const lastProcessedBlock = lastState?.lastBlockNumber || 0;

      // Get new blocks since last processed
      console.log("REACHED HERE 2")
      const newBlocks =
        process.env.USE_DEMO_DATA === "true"
          ? demoBlocks
          : await this.getNewBlocks(lastProcessedBlock);

      if (newBlocks.length === 0) {
        console.log("No new blocks to process");
        return;
      }

      // Process everything in a single transaction
      await this.getTWAPs(newBlocks);
      console.log(`Processed ${newBlocks.length} blocks for TWAP updates`);
    } catch (error) {
      console.error("Error updating TWAPs:", error);
      throw error;
    }
  }

  public async cleanup(): Promise<void> {
    if (process.env.USE_DEMO_DATA !== 'true') {
      await this.fossilClient?.end();
      await this.pitchlakeClient?.end();
    }
  }
}
