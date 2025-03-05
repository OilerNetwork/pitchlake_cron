-- Create function to notify confirmed inserts
CREATE OR REPLACE FUNCTION notify_confirmed_insert()
RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify(
        'confirmed_insert',
        json_build_object(
            'start_timestamp', TG_ARGV[0],
            'end_timestamp', TG_ARGV[1]
        )::text
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create function to notify unconfirmed inserts
CREATE OR REPLACE FUNCTION notify_unconfirmed_insert()
RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify(
        'unconfirmed_insert',
        row_to_json(NEW)::text
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for unconfirmed inserts
CREATE TRIGGER notify_unconfirmed_insert_trigger
    AFTER INSERT ON blocks
    FOR EACH ROW
    WHEN (NOT NEW.is_confirmed)
    EXECUTE FUNCTION notify_unconfirmed_insert(); 