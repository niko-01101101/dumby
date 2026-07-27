-- Backs todo.txt #3/#4/#5: a generic wake-up mechanism for otherwise-idle
-- entities. targetType/targetID is a polymorphic reference (Manager or
-- ContentCreator today) rather than two nullable FK columns, since a
-- reminder always points at exactly one kind of target and an ENUM-based
-- switch is simpler than juggling two mutually-exclusive nullable FKs.
-- targetType/targetID/wakeAt all have defaults despite being logically
-- required, matching every other entity table in this codebase: Entity.load()
-- (db.ts) does `INSERT INTO table (id) VALUES (?)` and relies on column
-- DEFAULTs for everything else, then immediately overwrites them via
-- Reminder.schedule()'s setTargetType()/setTargetID()/setWakeAt() calls.
CREATE TABLE IF NOT EXISTS reminders (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  targetType ENUM('manager', 'contentCreator') NOT NULL DEFAULT 'manager',
  targetID VARCHAR(36) NOT NULL DEFAULT '',
  wakeAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  message TEXT NULL,
  fired TINYINT(1) NOT NULL DEFAULT 0,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deletedAt TIMESTAMP NULL DEFAULT NULL,
  INDEX idx_target (targetType, targetID),
  INDEX idx_wakeAt (wakeAt, fired)
);
