INSERT INTO customers SELECT g, 'user' || g || '@example.com' FROM generate_series(1, 1000) g;
INSERT INTO orders (customer_id, status, total, note)
SELECT 1 + (g % 1000), CASE WHEN g % 10 = 0 THEN 'paid' ELSE 'new' END, (g % 500) + 0.5, 'n'
FROM generate_series(1, {{rows}}) g;
