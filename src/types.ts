export interface RawBlockData {
    block_number?: number;
    base_fee_per_gas?: string;
    timestamp: number;
  }
  
  export interface FormattedBlockData {
    blockNumber: number | undefined;
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
  