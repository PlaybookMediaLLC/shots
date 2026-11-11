-- OAuth credentials belong to the live Shots session; deleting it revokes native access.
CREATE TABLE "oauthClient" (
  "id" TEXT PRIMARY KEY,
  "clientId" TEXT NOT NULL UNIQUE,
  "clientSecret" TEXT,
  "disabled" BOOLEAN,
  "skipConsent" BOOLEAN,
  "enableEndSession" BOOLEAN,
  "subjectType" TEXT,
  "scopes" TEXT,
  "userId" TEXT REFERENCES "user" ("id") ON DELETE CASCADE,
  "createdAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3),
  "name" TEXT,
  "uri" TEXT,
  "icon" TEXT,
  "contacts" TEXT,
  "tos" TEXT,
  "policy" TEXT,
  "softwareId" TEXT,
  "softwareVersion" TEXT,
  "softwareStatement" TEXT,
  "redirectUris" TEXT NOT NULL,
  "postLogoutRedirectUris" TEXT,
  "tokenEndpointAuthMethod" TEXT,
  "grantTypes" TEXT,
  "responseTypes" TEXT,
  "public" BOOLEAN,
  "type" TEXT,
  "requirePKCE" BOOLEAN,
  "referenceId" TEXT,
  "metadata" TEXT
);

CREATE INDEX "oauthClient_userId_idx" ON "oauthClient" ("userId");

CREATE TABLE "oauthRefreshToken" (
  "id" TEXT PRIMARY KEY,
  "token" TEXT NOT NULL UNIQUE,
  "clientId" TEXT NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "sessionId" TEXT NOT NULL REFERENCES "session" ("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "referenceId" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "revoked" TIMESTAMP(3),
  "authTime" TIMESTAMP(3),
  "scopes" TEXT NOT NULL
);

CREATE INDEX "oauthRefreshToken_clientId_idx" ON "oauthRefreshToken" ("clientId");
CREATE INDEX "oauthRefreshToken_sessionId_idx" ON "oauthRefreshToken" ("sessionId");
CREATE INDEX "oauthRefreshToken_userId_idx" ON "oauthRefreshToken" ("userId");

CREATE TABLE "oauthAccessToken" (
  "id" TEXT PRIMARY KEY,
  "token" TEXT NOT NULL UNIQUE,
  "clientId" TEXT NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "sessionId" TEXT NOT NULL REFERENCES "session" ("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "referenceId" TEXT,
  "refreshId" TEXT REFERENCES "oauthRefreshToken" ("id") ON DELETE CASCADE,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "scopes" TEXT NOT NULL
);

CREATE INDEX "oauthAccessToken_clientId_idx" ON "oauthAccessToken" ("clientId");
CREATE INDEX "oauthAccessToken_sessionId_idx" ON "oauthAccessToken" ("sessionId");
CREATE INDEX "oauthAccessToken_userId_idx" ON "oauthAccessToken" ("userId");
CREATE INDEX "oauthAccessToken_refreshId_idx" ON "oauthAccessToken" ("refreshId");

CREATE TABLE "oauthConsent" (
  "id" TEXT PRIMARY KEY,
  "clientId" TEXT NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "referenceId" TEXT,
  "scopes" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE INDEX "oauthConsent_clientId_idx" ON "oauthConsent" ("clientId");
CREATE INDEX "oauthConsent_userId_idx" ON "oauthConsent" ("userId");

CREATE TABLE "jwks" (
  "id" TEXT PRIMARY KEY,
  "publicKey" TEXT NOT NULL,
  "privateKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3)
);


INSERT INTO "oauthClient" (
  "id", "clientId", "name", "redirectUris", "scopes", "grantTypes", "responseTypes",
  "tokenEndpointAuthMethod", "public", "requirePKCE", "skipConsent", "disabled"
) VALUES (
  'platform-founder-hub', 'shots-founder-hub', 'Shots Founder Hub',
  '["anarlog://auth/callback","anarlog-dev://auth/callback","anarlog-staging://auth/callback","anarlog-nightly://auth/callback","http://127.0.0.1/auth/callback"]',
  '["openid","profile","email","offline_access","founder-hub"]',
  '["authorization_code","refresh_token"]', '["code"]', 'none', true, true, true, false
);

CREATE FUNCTION platform_oauth_live_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM "session" s JOIN "user" u ON u.id=s."userId"
    WHERE s.id=NEW."sessionId" AND s."userId"=NEW."userId" AND s."expiresAt">now()
      AND (NOT coalesce(u.banned,false) OR u."banExpires"<now())
    FOR SHARE OF s,u;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OAuth requires a live Shots session' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER platform_oauth_refresh_session BEFORE INSERT ON "oauthRefreshToken"
  FOR EACH ROW EXECUTE FUNCTION platform_oauth_live_session();
CREATE TRIGGER platform_oauth_access_session BEFORE INSERT ON "oauthAccessToken"
  FOR EACH ROW EXECUTE FUNCTION platform_oauth_live_session();
