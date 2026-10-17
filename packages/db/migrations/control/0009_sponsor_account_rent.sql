-- Private purchases reserved sponsor lamports for the fresh-wallet ATA and fees only. The spend
-- also creates the spent-nullifier and pending-change accounts, whose rent is never refunded, so
-- rows still at the old 2,100,000 default are raised to cover all three accounts and both fees.
UPDATE service_sku SET sponsor_lamports = 5200000 WHERE payment_path = 'private_x402' AND sponsor_lamports = 2100000;
