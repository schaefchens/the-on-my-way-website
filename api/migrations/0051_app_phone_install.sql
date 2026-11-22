-- 0051_app_phone_install: which app install a connected phone is (review R3).
--
-- The app sends a random install id with every pairing (AppPairRequest.installId, kept on the phone,
-- never in a backup); only its sha256 is stored here. When the same install pairs again (the owner
-- disconnected it after a false alarm, its token expired after 180 days, or the phone lost its key),
-- the new connection takes over the entries of the install's earlier connections, so the moments
-- that were on their way continue where they stopped instead of being refused as another phone's.
-- Another phone (another install) still sees and changes only its own entries (Q4 a).
--
-- Sorts after 0050_app_inbox (which creates app_phones) and after every wave-5 000x file; purely
-- additive (a nullable column and an index).
ALTER TABLE app_phones ADD COLUMN install_hash TEXT CHECK (install_hash IS NULL OR length(install_hash) = 64);
CREATE INDEX IF NOT EXISTS app_phones_install ON app_phones (install_hash);
