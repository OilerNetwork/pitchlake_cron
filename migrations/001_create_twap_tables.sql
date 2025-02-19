-- Create enum for window types
CREATE TYPE twap_window_type AS ENUM ('twelve_min', 'three_hour', 'thirty_day');

-- Create blocks table
-- Table: public.blocks

-- DROP TABLE IF EXISTS public.blocks;

CREATE TABLE IF NOT EXISTS public.blocks
(
    block_number numeric(30,0) NOT NULL,
    "timestamp" numeric(30,0) NOT NULL,
    basefee numeric(30,9) NOT NULL,
    is_confirmed boolean NOT NULL DEFAULT false,
    twelve_min_twap numeric(30,9),
    three_hour_twap numeric(30,9),
    thirty_day_twap numeric(30,9),
    CONSTRAINT blocks_pkey PRIMARY KEY (block_number)
)
-- Create index on timestamp for efficient querying
CREATE INDEX IF NOT EXISTS blocks_timestamp_idx ON blocks(timestamp);
CREATE INDEX IF NOT EXISTS blocks_is_confirmed_idx ON blocks(is_confirmed);

-- Create twap_state table-- Table: public.twap_state

-- DROP TABLE IF EXISTS public.twap_state;

CREATE TABLE IF NOT EXISTS public.twap_state
(
    window_type twap_window_type NOT NULL,
    weighted_sum numeric(36,9) NOT NULL,
    total_seconds numeric(20,0) NOT NULL,
    is_confirmed boolean NOT NULL,
    twap_value numeric(30,9) NOT NULL,
    last_block_number numeric(20,0) NOT NULL,
    last_block_timestamp numeric(20,0) NOT NULL,
    CONSTRAINT twap_state_window_type_is_confirmed_key UNIQUE (window_type, is_confirmed)
)

-- Index: twap_state_last_block_timestamp_idx

-- DROP INDEX IF EXISTS public.twap_state_last_block_timestamp_idx;

CREATE INDEX IF NOT EXISTS twap_state_last_block_timestamp_idx
    ON public.twap_state USING btree
    (last_block_timestamp ASC NULLS LAST)
-- Index: twap_state_window_type_confirmed_key

-- DROP INDEX IF EXISTS public.twap_state_window_type_confirmed_key;

CREATE UNIQUE INDEX IF NOT EXISTS twap_state_window_type_confirmed_key
    ON public.twap_state USING btree
    (window_type ASC NULLS LAST)
    TABLESPACE pg_default
    WHERE is_confirmed = true;