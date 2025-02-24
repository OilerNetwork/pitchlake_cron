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
    this.fossilClient = new Client({
      connectionString: process.env.FOSSIL_DB_CONNECTION_STRING,
      ssl: {
        rejectUnauthorized: false
      }
    });
    this.pitchlakeClient = new Client({
      connectionString: process.env.PITCHLAKE_DB_CONNECTION_STRING,
      ssl: false
    });
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
        weighted_sum = EXCLUDED.weighted_sum,
        total_seconds = EXCLUDED.total_seconds,
        twap_value = EXCLUDED.twap_value,
        last_block_number = EXCLUDED.last_block_number,
        last_block_timestamp = EXCLUDED.last_block_timestamp
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
      VALUES ($1, $2, $3, true)
      ON CONFLICT (block_number) 
      DO UPDATE SET 
        basefee = EXCLUDED.basefee,
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

      // Initialize state once at the start
      const states = await Promise.all(
        this.WINDOW_CONFIGS.map((config) => this.getTWAPState(config.type))
      );
      let currentState = this.initializeTWAPState(states);

      // Process each block in its own transaction
      for (const currentBlock of sortedBlocks) {
        try {
          if (process.env.USE_DEMO_DATA !== 'true') {
            await this.pitchlakeClient?.query("BEGIN");
            
            // Store the new block first
            await this.storeNewBlocks([currentBlock]);
          }

          // Fetch relevant blocks for TWAP calculation
          const relevantBlocks = await this.fetchRelevantBlocks(
            oldestTimestamp,
            currentBlock.timestamp
          );

          if (relevantBlocks.length === 0) {
            console.log(`No relevant blocks found for block ${currentBlock.blockNumber}`);
            if (process.env.USE_DEMO_DATA !== 'true') {
              await this.pitchlakeClient?.query("ROLLBACK");
            }
            continue;
          }

          // Only skip if this is the absolute latest block in our batch AND it's the last block we have
          const isLastBlockInBatch = currentBlock.blockNumber === sortedBlocks[sortedBlocks.length - 1].blockNumber;
          const hasNextBlock = await this.checkForNextBlock(currentBlock.blockNumber);
          const isLatestBlock = isLastBlockInBatch && !hasNextBlock;

          if (isLatestBlock) {
            console.log(`Skipping latest block ${currentBlock.blockNumber} for TWAP updates`);
            if (process.env.USE_DEMO_DATA !== 'true') {
              await this.pitchlakeClient?.query("ROLLBACK");
            }
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

          if (process.env.USE_DEMO_DATA === 'true') {
            // Handle demo mode
            const blockTWAPData = {
              block_number: currentBlock.blockNumber!,
              timestamp: currentBlock.timestamp,
              basefee: currentBlock.basefee!,
              twelve_min_twap: currentState.twelveminTwap.twapValue,
              three_hour_twap: currentState.threeHourTwap.twapValue,
              thirty_day_twap: currentState.thirtyDayTwap.twapValue
            };
            console.log(`Demo Mode - Processed block ${blockTWAPData.block_number}`);
          } else {
            // Update block TWAPs
            await this.updateBlockTWAPs(
              currentBlock.blockNumber!,
              currentState.twelveminTwap.twapValue,
              currentState.threeHourTwap.twapValue,
              currentState.thirtyDayTwap.twapValue
            );

            // Save the updated state for each window type
            await Promise.all(
              this.WINDOW_CONFIGS.map((config) =>
                this.saveTWAPState(config.type, currentState[config.stateKey])
              )
            );

            // Commit the transaction for this block
            await this.pitchlakeClient?.query("COMMIT");
            console.log(`Successfully processed block ${currentBlock.blockNumber}`);
          }
        } catch (error) {
          console.error(`Error processing block ${currentBlock.blockNumber}:`, error);
          if (process.env.USE_DEMO_DATA !== 'true') {
            await this.pitchlakeClient?.query("ROLLBACK");
          }
          // Continue with the next block instead of throwing
          continue;
        }
      }

      if (process.env.USE_DEMO_DATA === 'true') {
        // Log final states to console for demo mode
        console.log('Demo Mode - Final TWAP States:');
        this.WINDOW_CONFIGS.forEach(config => {
          console.log(`${config.type}:`, currentState[config.stateKey]);
        });
      }
    } catch (error) {
      console.error("Error in getTWAPs:", error);
      throw error;
    }
  }

  public async updateTWAPs(): Promise<void> {
    console.log("Starting TWAP updates");
    if (process.env.USE_DEMO_DATA !== 'true') {
      
      try {
        await this.fossilClient?.connect();
        await this.pitchlakeClient?.connect();
      } catch (error) {
        console.error("Error connecting to fossil or pitchlake:", error);
        throw error;
      }
    }

    try {
      if (process.env.USE_DEMO_DATA === 'true') {
        console.log('Running in demo mode with sample data');
        const newBlocks = demoBlocks;
        await this.getTWAPs(newBlocks);
        return;
      }

      const BATCH_SIZE = 1000;
      let hasMoreBlocks = true;

      // Get last processed block from TWAP state or use initial block from env
      const lastState = await this.getTWAPState("twelve_min");
      let currentLastBlock: number;
      
      if (lastState?.lastBlockNumber) {
        currentLastBlock = lastState.lastBlockNumber;
        console.log("Resuming from last processed block:", currentLastBlock);
      } else {
        const initialBlock = process.env.INITIAL_BLOCK_NUMBER ? parseInt(process.env.INITIAL_BLOCK_NUMBER) : 0;
        currentLastBlock = initialBlock;
        console.log("No TWAP state found. Starting from initial block:", initialBlock);
      }

      while (hasMoreBlocks) {
        // Fetch next batch of blocks
        const query = `
          SELECT number, timestamp, base_fee_per_gas
          FROM blockheaders 
          WHERE number > $1
          AND base_fee_per_gas IS NOT NULL
          ORDER BY number ASC
          LIMIT $2
        `;

        const result = await this.fossilClient?.query(query, [currentLastBlock, BATCH_SIZE]);
        
        if (!result || result.rows.length === 0) {
          console.log("No more blocks to process");
          hasMoreBlocks = false;
          break;
        }

        const blocks = result.rows.map((row) => ({
          blockNumber: row.number,
          timestamp: Number(row.timestamp),
          basefee: row.base_fee_per_gas ? Number(row.base_fee_per_gas) : undefined,
        }));

        console.log(`Processing batch of ${blocks.length} blocks starting from ${blocks[0].blockNumber}`);

        // Process this batch of blocks
        await this.getTWAPs(blocks);

        // Update the last processed block for the next iteration
        currentLastBlock = blocks[blocks.length - 1].blockNumber;
        console.log(`Completed processing batch. Last block: ${currentLastBlock}`);

        // If we got fewer blocks than the batch size, we've reached the end
        if (blocks.length < BATCH_SIZE) {
          console.log("Reached end of blocks");
          hasMoreBlocks = false;
        }
      }

      console.log("Completed all TWAP updates");
    } catch (error) {
      console.error("Error updating TWAPs:", error);
      throw error;
    } finally {
      await this.cleanup();
    }
  }

  private async getNewBlocks(
    lastProcessedBlock: number
  ): Promise<FormattedBlockData[]> {
    if (process.env.USE_DEMO_DATA === 'true') {
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
      LIMIT 1000
    `;

    const result = await this.fossilClient?.query(query, [lastProcessedBlock]);
    
    if (!result) {
      throw new Error('Failed to fetch new blocks');
    }

    return result.rows.map((row) => ({
      blockNumber: row.number,
      timestamp: Number(row.timestamp),
      basefee: row.base_fee_per_gas ? Number(row.base_fee_per_gas) : undefined,
    }));
  }

  public async cleanup(): Promise<void> {
    if (process.env.USE_DEMO_DATA !== 'true') {
      await this.fossilClient?.end();
      await this.pitchlakeClient?.end();
    }
  }

  private async checkForNextBlock(blockNumber: number): Promise<boolean> {
    if (process.env.USE_DEMO_DATA === 'true') {
      const nextBlock = demoBlocks.find(block => block.blockNumber > blockNumber);
      return !!nextBlock;
    }

    const query = `
      SELECT 1
      FROM blockheaders 
      WHERE number > $1
      AND base_fee_per_gas IS NOT NULL
      LIMIT 1
    `;

    const result = await this.fossilClient?.query(query, [blockNumber]);
    return !!(result?.rows.length);
  }
}
