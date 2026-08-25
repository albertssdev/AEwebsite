ALTER TABLE contributions ADD COLUMN fee_amount REAL;
ALTER TABLE contributions ADD COLUMN fee_paid_by TEXT;
ALTER TABLE contributions ADD COLUMN attestation_signed INTEGER NOT NULL DEFAULT 0;
