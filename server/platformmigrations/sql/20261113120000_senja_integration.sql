-- Composer slice 3c: a workspace's own Senja API key, pasted by an admin and
-- sealed like other integration credentials, for importing testimonials.
ALTER TABLE "integration_connection" DROP CONSTRAINT "integration_connection_provider_check";
ALTER TABLE "integration_connection" ADD CONSTRAINT "integration_connection_provider_check"
  CHECK ("provider" IN ('SLACK', 'NOTION', 'FIGMA', 'SENJA'));
