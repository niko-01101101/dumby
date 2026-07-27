ALTER TABLE accounts
  ADD COLUMN platform ENUM('youtube', 'tiktok', 'instagram_reels') NOT NULL DEFAULT 'youtube' AFTER contentCreatorID;
