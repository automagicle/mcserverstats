-- Website analytics for the admin page's Analytics tab: one row per visitor, page and UTC day.
-- visitor is the Cloudflare Access login email; page is the route (home, chat, combat, admin, player:<uuid>).
CREATE TABLE site_visits (
  day     TEXT    NOT NULL,           -- YYYY-MM-DD, UTC
  visitor TEXT    NOT NULL,
  page    TEXT    NOT NULL,
  views   INTEGER NOT NULL DEFAULT 0,
  minutes INTEGER NOT NULL DEFAULT 0, -- minutes the page was open and visible
  mobile  INTEGER NOT NULL DEFAULT 0, -- seen on a phone that day
  last_ts INTEGER NOT NULL,           -- unix seconds
  PRIMARY KEY (day, visitor, page)
) WITHOUT ROWID;
CREATE INDEX site_visits_visitor ON site_visits (visitor, day);
