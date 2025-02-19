-- Drop foreign key constraint first
ALTER TABLE twap_state DROP CONSTRAINT IF EXISTS fk_last_block;

-- Drop indexes
DROP INDEX IF EXISTS blocks_timestamp_idx;
DROP INDEX IF EXISTS twap_state_last_block_timestamp_idx;

-- Drop tables
DROP TABLE IF EXISTS twap_state;
DROP TABLE IF EXISTS blocks;

-- Drop enum type
DROP TYPE IF EXISTS twap_window_type; 