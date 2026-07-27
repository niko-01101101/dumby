ALTER TABLE media
  MODIFY COLUMN source ENUM('generated', 'pexels', 'pixabay', 'twitch', 'piper', 'google-tts', 'freesound') NOT NULL DEFAULT 'generated';
