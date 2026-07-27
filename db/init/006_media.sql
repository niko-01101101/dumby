CREATE TABLE IF NOT EXISTS media (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  videoID VARCHAR(36) NULL,
  kind ENUM('clip', 'image', 'audio') NOT NULL DEFAULT 'clip',
  source ENUM('generated', 'pexels', 'pixabay', 'twitch', 'piper', 'google-tts', 'freesound') NOT NULL DEFAULT 'generated',
  sourceRef TEXT NULL,
  localPath TEXT NULL,
  position INT NOT NULL DEFAULT 0,
  FOREIGN KEY (videoID) REFERENCES videos(id) ON DELETE CASCADE,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deletedAt TIMESTAMP NULL DEFAULT NULL,
  INDEX idx_video (videoID)
);
