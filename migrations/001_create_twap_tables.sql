-- Create enum for window types
CREATE TYPE twap_window_type AS ENUM ('twelve_min', 'three_hour', 'thirty_day');

-- Create blocks table
CREATE TABLE IF NOT EXISTS blocks (
    block_number NUMERIC(20) PRIMARY KEY,  -- Large enough for block numbers
    timestamp NUMERIC(20) NOT NULL,        -- Unix timestamp
    basefee NUMERIC(30, 9) NOT NULL,      -- Gas prices with 9 decimals
    is_confirmed BOOLEAN NOT NULL DEFAULT false,  -- Track confirmation status
    twelve_min_twap NUMERIC(30, 9),       -- TWAP values with 9 decimals
    three_hour_twap NUMERIC(30, 9),
    thirty_day_twap NUMERIC(30, 9)
);

-- Create index on timestamp for efficient querying
CREATE INDEX IF NOT EXISTS blocks_timestamp_idx ON blocks(timestamp);
CREATE INDEX IF NOT EXISTS blocks_is_confirmed_idx ON blocks(is_confirmed);

-- Create twap_state table
CREATE TABLE IF NOT EXISTS twap_state (
    window_type twap_window_type PRIMARY KEY,
    weighted_sum NUMERIC(36, 9) NOT NULL,  -- Larger precision for sum of (price * duration)
    total_seconds NUMERIC(20) NOT NULL,    -- Duration in seconds
    twap_value NUMERIC(30, 9) NOT NULL,   -- Final TWAP value with 9 decimals
    last_block_number NUMERIC(20) NOT NULL,
    last_block_timestamp NUMERIC(20) NOT NULL
);

-- Create index on last_block_timestamp for efficient querying
CREATE INDEX IF NOT EXISTS twap_state_last_block_timestamp_idx ON twap_state(last_block_timestamp);