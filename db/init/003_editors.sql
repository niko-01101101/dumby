CREATE TABLE IF NOT EXISTS editors (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  contentCreatorID VARCHAR(36) NULL,
  state ENUM('online', 'starting', 'offline', 'shuttingDown', 'stuck') NOT NULL DEFAULT 'offline',
  FOREIGN KEY (contentCreatorID) REFERENCES contentCreators(id) ON DELETE CASCADE,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deletedAt TIMESTAMP NULL DEFAULT NULL,
  INDEX idx_contentCreator (contentCreatorID)
);
