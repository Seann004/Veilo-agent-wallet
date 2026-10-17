-- Pages a task's agent opened with the read-only browser; bounded per task. Permitted URLs are
-- kept per task so a brief may cite exactly the pages control authorized, and nothing else.
ALTER TABLE task ADD COLUMN browse_calls INTEGER NOT NULL DEFAULT 0;

CREATE TABLE browse_page (
  task_id TEXT NOT NULL REFERENCES task(id),
  url TEXT NOT NULL CHECK (length(url) <= 2048),
  permitted_at_ms INTEGER NOT NULL,
  PRIMARY KEY (task_id, url)
) STRICT;
