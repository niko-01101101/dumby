CREATE TABLE IF NOT EXISTS managers (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  state ENUM('online', 'starting', 'offline', 'shuttingDown', 'stuck') NOT NULL DEFAULT 'offline',
  maxAllocatedCreators INT DEFAULT 5 CHECK (maxAllocatedCreators > 0),
  maxAllocatedEditors INT DEFAULT 10 CHECK (maxAllocatedEditors > 0),
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deletedAt TIMESTAMP NULL DEFAULT NULL
);
