SET LOCAL lock_timeout = '200ms';
ALTER TABLE orders ADD COLUMN coupon text;
