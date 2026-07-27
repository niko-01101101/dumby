CREATE TABLE IF NOT EXISTS contentCreators (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  managerID VARCHAR(36) NULL,
  personality TEXT NULL,
  typeOfContent TEXT NULL,
  state ENUM('online', 'starting', 'offline', 'shuttingDown', 'stuck') NOT NULL DEFAULT 'offline',
  FOREIGN KEY (managerID) REFERENCES managers(id) ON DELETE CASCADE,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deletedAt TIMESTAMP NULL DEFAULT NULL,
  INDEX idx_managerID (managerID)
);
