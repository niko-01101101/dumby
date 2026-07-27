ALTER TABLE managers
  ADD COLUMN releaseIntervalMinutes INT NOT NULL DEFAULT 1440 CHECK (releaseIntervalMinutes > 0) AFTER maxAllocatedEditors;
