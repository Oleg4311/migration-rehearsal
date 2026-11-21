SET lock_timeout = '200ms';
CREATE INDEX CONCURRENTLY orders_customer_idx ON orders (customer_id);
