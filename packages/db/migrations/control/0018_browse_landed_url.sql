-- A permitted page may redirect; the URL it landed on is kept beside the permitted one so a brief
-- can cite the page that was actually read. Each permitted URL has at most one landed URL.
ALTER TABLE browse_page ADD COLUMN redirected_from TEXT CHECK (redirected_from IS NULL OR length(redirected_from) <= 2048);
CREATE UNIQUE INDEX browse_page_one_landing ON browse_page (task_id, redirected_from) WHERE redirected_from IS NOT NULL;
