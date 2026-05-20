-- Reseed workspace tile colors with theme-derived palette tokens.
-- Pre-theme rows hold static oklch() literals; replace them (and any
-- NULLs) with a random theme color var(). Rows already on a var(--…)
-- token are left untouched so this stays idempotent.
UPDATE tenants
SET color = (
  CASE abs(random()) % 6
    WHEN 0 THEN 'var(--primary)'
    WHEN 1 THEN 'var(--chart-1)'
    WHEN 2 THEN 'var(--chart-2)'
    WHEN 3 THEN 'var(--chart-3)'
    WHEN 4 THEN 'var(--chart-4)'
    ELSE 'var(--chart-5)'
  END
)
WHERE color IS NULL OR color NOT LIKE 'var(--%';
