-- Reseed workspace tile colors with theme-derived palette tokens.
UPDATE tenants
SET color = (ARRAY[
  'var(--primary)','var(--chart-1)','var(--chart-2)',
  'var(--chart-3)','var(--chart-4)','var(--chart-5)'
])[floor(random() * 6)::int + 1]
WHERE color IS NULL OR color NOT LIKE 'var(--%';
