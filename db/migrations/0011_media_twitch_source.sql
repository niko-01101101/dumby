ALTER TABLE media
  MODIFY COLUMN source ENUM('generated', 'pexels', 'pixabay', 'twitch', 'piper', 'freesound') NOT NULL DEFAULT 'generated';
