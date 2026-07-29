ALTER TABLE communities
  ADD COLUMN razorpay_account_id TEXT,
  ADD COLUMN razorpay_account_status TEXT NOT NULL DEFAULT 'not_onboarded'
    CHECK (razorpay_account_status IN ('not_onboarded', 'pending', 'activated', 'rejected')),
  ADD COLUMN commission_percent NUMERIC(5,2) NOT NULL DEFAULT 10.00
    CHECK (commission_percent >= 0 AND commission_percent <= 100),
  ADD COLUMN commission_on TEXT NOT NULL DEFAULT 'pre_discount'
    CHECK (commission_on IN ('pre_discount', 'post_discount'));

ALTER TABLE profiles
  ADD COLUMN razorpay_contact_id TEXT,
  ADD COLUMN razorpay_fund_account_id TEXT,
  ADD COLUMN bank_account_holder TEXT,
  ADD COLUMN bank_ifsc TEXT,
  ADD COLUMN bank_account_number TEXT,
  ADD COLUMN pan TEXT,
  ADD COLUMN kyc_status TEXT NOT NULL DEFAULT 'not_submitted'
    CHECK (kyc_status IN ('not_submitted', 'pending', 'verified', 'rejected'));
