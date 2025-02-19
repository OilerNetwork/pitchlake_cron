export interface RawBlockData {
    block_number?: number;
    base_fee_per_gas?: string;
    timestamp: number;
  }
  
  export interface FormattedBlockData {
    blockNumber: number;
    timestamp: number;
    basefee: number | undefined;
  
  }
  
  export interface GasData {
    blockNumber: number;
    timestamp: number;
    basefee: number;
  }

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
  
  export interface BlockTWAPData extends FormattedBlockData {
    twelveminTwap?: TWAPMetrics;
    threeHourTwap?: TWAPMetrics;
    thirtyDayTwap?: TWAPMetrics;
  }
  
export type TWAPWindowType = 'twelve_min' | 'three_hour' | 'thirty_day';

export interface TWAPState {
  weightedSum: number;
  totalSeconds: number;
  twapValue: number;
  lastBlockNumber: number;
  lastBlockTimestamp: number;
}

export interface BlockWithNextTimestamp {
  timestamp: number;
  next_timestamp: number | null;
  basefee: number;
}

export interface TWAPStateContainer {
  twelveminTwap: TWAPState;
  threeHourTwap: TWAPState;
  thirtyDayTwap: TWAPState;
}
  