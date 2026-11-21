SET LOCAL lock_timeout = '200ms';
ALTER TABLE orders VALIDATE CONSTRAINT orders_note_nn;
