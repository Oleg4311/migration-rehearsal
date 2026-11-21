SET LOCAL lock_timeout = '200ms';
ALTER TABLE orders ADD CONSTRAINT orders_note_nn CHECK (note IS NOT NULL) NOT VALID;
