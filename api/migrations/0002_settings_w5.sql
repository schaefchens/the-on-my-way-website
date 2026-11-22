-- 0002_settings_w5: new settings (Q1/Q2, time precision), announced on the change feed like 0001 did
-- (spec-wave5.md §4.2). Conventions as in 0001.
INSERT INTO settings (key, value, updated_at) VALUES
    ('publish.release_slots',  '{"enabled":false,"times":["08:00","20:00"]}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('publish.departure_hold', '{"enabled":false,"maxDays":7}',               strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('site.here_now',          '"city_badge"',                                strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('site.time_precision',    '"exact"',                                     strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
INSERT INTO change_log (entity, entity_key, op, data, created_at)
SELECT 'setting', key, 'upsert', json_object('value', json(value)), updated_at FROM settings
WHERE key IN ('publish.release_slots', 'publish.departure_hold', 'site.here_now', 'site.time_precision')
ORDER BY key;
