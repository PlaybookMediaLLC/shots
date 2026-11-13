-- Keep the redacted provider refusal beside an automation's status code.
ALTER TABLE post_automation_run ADD COLUMN "providerMessage" text;
