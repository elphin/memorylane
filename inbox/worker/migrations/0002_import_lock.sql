-- Import-lock: wanneer de desktop een memory is gaan binnenhalen (GET /urls).
-- Zolang dat recent is, mag de telefoon hem niet intrekken of vervangen; anders
-- kan hij thuis dubbel binnenkomen (oude versie afgemaakt + nieuwe versie).
ALTER TABLE memories ADD COLUMN import_started_at TEXT;
