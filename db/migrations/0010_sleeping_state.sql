ALTER TABLE contentCreators
  MODIFY COLUMN state ENUM('online', 'starting', 'offline', 'shuttingDown', 'stuck', 'sleeping') NOT NULL DEFAULT 'offline';

ALTER TABLE editors
  MODIFY COLUMN state ENUM('online', 'starting', 'offline', 'shuttingDown', 'stuck', 'sleeping') NOT NULL DEFAULT 'offline';
