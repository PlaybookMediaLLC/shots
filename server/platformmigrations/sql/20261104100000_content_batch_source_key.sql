-- Bulk Tools: the file or folder name an item came from, as the person knows it.
-- Stored file names are sanitized for object keys, and a caption CSV must match
-- the original. Additive: old code ignores the column; rollback is DROP COLUMN.
ALTER TABLE content_batch_item
 ADD COLUMN "sourceKey" text NOT NULL DEFAULT '' CHECK (length("sourceKey") <= 255);
