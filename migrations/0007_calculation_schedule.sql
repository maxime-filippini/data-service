-- Migration number: 0007

-- The latest cron slot (a whole UTC hour, ISO 8601) the hourly tick started a
-- run for. A calculation runs when its most recent slot is after this and
-- after its creation, so a missed slot runs once, not once per slot missed.
ALTER TABLE calculations ADD COLUMN last_scheduled_slot TEXT;
