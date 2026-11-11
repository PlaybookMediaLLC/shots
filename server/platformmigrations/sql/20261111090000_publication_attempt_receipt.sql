-- What each publication attempt leaves for support and audit: the provider's
-- message, redacted of tokens and signed URLs, and the live post's address.
-- Attempts recorded before this change keep NULL; their codes still explain them.
ALTER TABLE publication_attempt ADD COLUMN "providerMessage" text;
ALTER TABLE publication_attempt ADD COLUMN "remoteUrl" text;
