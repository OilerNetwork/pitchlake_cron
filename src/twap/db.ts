import { Pool } from 'pg';
import { FormattedBlockData } from './gasData';

// Time ranges in seconds
export const TWAP_RANGES = {
  TWELVE_MIN: 12 * 60,        // 12 minutes
  THREE_HOURS: 3 * 60 * 60,   // 3 hours
  THIRTY_DAYS: 30 * 24 * 60 * 60  // 30 days
} as const;

interface TWAPMetrics {
  weightedSum: number;
  totalSeconds: number;
  twapValue: number;
}

interface BlockTWAPData extends FormattedBlockData {
  twelveminTwap?: TWAPMetrics;
  threeHourTwap?: TWAPMetrics;
  thirtyDayTwap?: TWAPMetrics;
}

export async function fetchBlockTWAPData(
  pool: Pool,
  blockNumber: number
): Promise<BlockTWAPData | null> {
  const query = `
    SELECT 
      block_number,
      timestamp,
      basefee,
      is_unconfirmed,
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
    const result = await pool.query(query, [blockNumber]);
    
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
        twapValue: row.twelvemin_twap
      },
      threeHourTwap: {
        weightedSum: row.threehour_weighted_sum,
        totalSeconds: row.threehour_total_seconds,
        twapValue: row.threehour_twap
      },
      thirtyDayTwap: {
        weightedSum: row.thirtyday_weighted_sum,
        totalSeconds: row.thirtyday_total_seconds,
        twapValue: row.thirtyday_twap
      }
    };
  } catch (error) {
    console.error('Error fetching block TWAP data:', error);
    throw error;
  }
}
