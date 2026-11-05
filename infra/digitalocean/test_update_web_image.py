import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("update_web_image", Path(__file__).with_name("update-web-image.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class UpdateWebImageTest(unittest.TestCase):
    def setUp(self):
        image = dict(module.IMAGE, digest="sha256:" + "a" * 64)
        self.base = {"spec": {
            "services": [
                {"name": "web", "image": image, "envs": [{"key": "REDIS_URL", "value": "old", "type": "SECRET"},
                                                         {"key": "DATABASE_URL", "value": "old", "type": "SECRET"},
                                                         {"key": "R2_SECRET_ACCESS_KEY", "value": "old", "type": "SECRET"},
                                                         {"key": "R2_ENDPOINT", "value": "old", "type": "GENERAL"},
                                                         {"key": "PLATFORM_RENDER_SERVICE_URL", "value": "http://design-renderer:8080", "type": "GENERAL"}]},
                {"name": "storage"}, {"name": "design-renderer"},
                {"name": "screenshot-studio-backend"},
            ],
            "jobs": [
                {"name": "platform-migrate", "image": {"tag": "social-backend-sha"}},
                {"name": "social-migrate"},
            ],
            "domains": [{"domain": "shots.oppulence.io"}],
        }}

    def test_updates_only_web_image_and_refreshes_scoped_credentials(self):
        tag = "web-" + "b" * 40
        cdp = {"PLATFORM_RENDER_CDP_URL": "wss://render.example/devtools", "PLATFORM_RENDER_CDP_TOKEN": "cdp-token"}
        result = module.update_web_image(self.base, tag, {"REDIS_URL": "runtime-redis", **cdp})
        self.assertEqual(result["services"][0]["image"], dict(module.IMAGE, tag=tag))
        self.assertEqual(result["jobs"], self.base["spec"]["jobs"])
        self.assertEqual(result["services"][0]["envs"][0]["value"], "runtime-redis")
        web_keys = {item["key"] for item in result["services"][0]["envs"]}
        self.assertFalse(web_keys & {"DATABASE_URL", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT", "PLATFORM_RENDER_SERVICE_URL"})
        web_envs = {item["key"]: item for item in result["services"][0]["envs"]}
        self.assertEqual(web_envs["PLATFORM_RENDER_CDP_URL"]["value"], "wss://render.example/devtools")
        self.assertEqual(web_envs["PLATFORM_RENDER_CDP_TOKEN"]["value"], "cdp-token")
        self.assertNotIn("design-renderer", {item["name"] for item in result["services"]})
        # The renderer is already gone on later deploys; the token is required.
        again = module.update_web_image(result, tag, {"REDIS_URL": "runtime-redis", **cdp})
        self.assertEqual(len(again["services"][0]["envs"]), len({item["key"] for item in again["services"][0]["envs"]}))
        with self.assertRaisesRegex(ValueError, "PLATFORM_RENDER_CDP_TOKEN"):
            module.update_web_image(result, tag, {"REDIS_URL": "runtime-redis",
                                                  "PLATFORM_RENDER_CDP_URL": "wss://render.example/devtools"})
        self.assertIn({"key": "CLIENT_IP_SOURCE", "value": "digitalocean",
                       "type": "GENERAL", "scope": "RUN_TIME"}, result["services"][0]["envs"])
        self.assertEqual(result["domains"], self.base["spec"]["domains"])
        self.assertEqual(self.base["spec"]["services"][0]["image"]["digest"], "sha256:" + "a" * 64)

    def test_removes_backend_slack_credentials_from_web(self):
        keys = {"SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "PLATFORM_SLACK_CALLBACK_URL",
                "PLATFORM_NOTIFICATION_ENCRYPTION_KEY"}
        web = self.base["spec"]["services"][0]
        web["envs"] += [{"key": key, "value": "old", "type": "SECRET"} for key in keys]
        web["envs"].append({"key": "INTEGRATION_ENCRYPTION_KEY", "value": "legacy", "type": "SECRET"})
        result = module.update_web_image(self.base, "web-" + "b" * 40)
        remaining = {item["key"] for item in result["services"][0]["envs"]}
        self.assertFalse(remaining & keys)
        self.assertIn("INTEGRATION_ENCRYPTION_KEY", remaining)

    def test_adds_stripe_billing_once_infisical_has_it(self):
        tag = "web-" + "b" * 40
        base = {"REDIS_URL": "runtime-redis", "PLATFORM_RENDER_CDP_URL": "wss://render.example/devtools",
                "PLATFORM_RENDER_CDP_TOKEN": "cdp-token"}
        without = module.update_web_image(self.base, tag, base)
        self.assertFalse({item["key"] for item in without["services"][0]["envs"]} & set(module.STRIPE_PRICE_KEYS))
        stripe = {"STRIPE_SECRET_KEY": "sk", "STRIPE_WEBHOOK_SECRET": "whsec", "STRIPE_PRICE_PRO_MONTHLY": "price_pro"}
        result = module.update_web_image(self.base, tag, {**base, **stripe})
        envs = {item["key"]: item for item in result["services"][0]["envs"]}
        self.assertEqual((envs["STRIPE_SECRET_KEY"]["type"], envs["STRIPE_SECRET_KEY"]["value"]), ("SECRET", "sk"))
        self.assertEqual((envs["STRIPE_WEBHOOK_SECRET"]["type"], envs["STRIPE_WEBHOOK_SECRET"]["value"]), ("SECRET", "whsec"))
        self.assertEqual((envs["STRIPE_PRICE_PRO_MONTHLY"]["type"], envs["STRIPE_PRICE_PRO_MONTHLY"]["value"]),
                         ("GENERAL", "price_pro"))
        again = module.update_web_image(result, tag, {**base, **stripe})
        self.assertEqual(len(again["services"][0]["envs"]), len({item["key"] for item in again["services"][0]["envs"]}))

    def test_content_drafts_and_collab_follow_infisical(self):
        tag = "web-" + "b" * 40
        base = {"REDIS_URL": "runtime-redis", "PLATFORM_RENDER_CDP_URL": "wss://render.example/devtools",
                "PLATFORM_RENDER_CDP_TOKEN": "cdp-token", "BETTER_AUTH_URL": "https://shots.example.com"}
        off = {item["key"] for item in module.update_web_image(self.base, tag, base)["services"][0]["envs"]}
        self.assertFalse(off & {"PLATFORM_CONTENT_DRAFTS", "PLATFORM_COLLAB_URL"})
        with_collab = dict(self.base["spec"], services=self.base["spec"]["services"] + [{"name": "collab"}])
        result = module.update_web_image(with_collab, tag, {**base, "PLATFORM_CONTENT_DRAFTS": "enabled"})
        envs = {item["key"]: item["value"] for item in result["services"][0]["envs"]}
        self.assertEqual(envs["PLATFORM_CONTENT_DRAFTS"], "enabled")
        self.assertEqual(envs["PLATFORM_COLLAB_URL"], "wss://shots.example.com/collab")
        self.assertIn("collab", {item["name"] for item in result["services"]})
        again = module.update_web_image(result, tag, {**base, "PLATFORM_CONTENT_DRAFTS": "enabled"})
        self.assertEqual(len(again["services"][0]["envs"]), len({item["key"] for item in again["services"][0]["envs"]}))

    def test_password_sign_in_follows_infisical_and_unset_keeps_the_live_value(self):
        tag = "web-" + "b" * 40
        base = {"REDIS_URL": "runtime-redis", "PLATFORM_RENDER_CDP_URL": "wss://render.example/devtools",
                "PLATFORM_RENDER_CDP_TOKEN": "cdp-token", "BETTER_AUTH_URL": "https://shots.example.com"}
        live = copy.deepcopy(self.base)
        live["spec"]["services"][0]["envs"].append({"key": "AUTH_ENABLE_PASSWORD", "value": "false", "type": "GENERAL", "scope": "RUN_TIME"})
        def values(result):
            return [item["value"] for item in result["services"][0]["envs"] if item["key"] == "AUTH_ENABLE_PASSWORD"]
        self.assertEqual(values(module.update_web_image(copy.deepcopy(live), tag, base)), ["false"])
        self.assertEqual(values(module.update_web_image(copy.deepcopy(live), tag, {**base, "AUTH_ENABLE_PASSWORD": "true"})), ["true"])

    def test_every_web_secret_comes_from_infisical(self):
        tag = "web-" + "b" * 40
        cdp = {"PLATFORM_RENDER_CDP_URL": "wss://render.example/devtools", "PLATFORM_RENDER_CDP_TOKEN": "cdp-token"}
        self.base["spec"]["services"][0]["envs"].append(
            {"key": "GITHUB_APP_WEBHOOK_SECRET", "value": "EV[live]", "type": "SECRET"})
        with self.assertRaisesRegex(ValueError, "Missing Infisical secret: GITHUB_APP_WEBHOOK_SECRET"):
            module.update_web_image(self.base, tag, {"REDIS_URL": "runtime-redis", **cdp})
        result = module.update_web_image(self.base, tag, {"REDIS_URL": "runtime-redis",
                                                          "GITHUB_APP_WEBHOOK_SECRET": "fresh", **cdp})
        envs = {item["key"]: item["value"] for item in result["services"][0]["envs"]}
        self.assertEqual(envs["GITHUB_APP_WEBHOOK_SECRET"], "fresh")

    def test_telemetry_settings_removed_from_infisical_leave_the_web(self):
        envs = self.base["spec"]["services"][0]["envs"]
        envs += [{"key": "OTEL_ENABLED", "value": "true", "type": "SECRET"},
                 {"key": "OTEL_EXPORTER_OTLP_TRACES_HEADERS", "value": "authorization=Bearer old", "type": "SECRET"}]
        secrets = {"REDIS_URL": "redis", "PLATFORM_RENDER_CDP_URL": "wss://render.example/devtools",
                   "PLATFORM_RENDER_CDP_TOKEN": "cdp-token", "OTEL_ENABLED": "true"}
        result = module.update_web_image(self.base, "web-" + "b" * 40, secrets)
        web_envs = {item["key"]: item["value"] for item in result["services"][0]["envs"]}
        self.assertEqual(web_envs["OTEL_ENABLED"], "true")
        self.assertNotIn("OTEL_EXPORTER_OTLP_TRACES_HEADERS", web_envs)

    def test_rejects_unexpected_topology_and_missing_secret(self):
        tag = "web-" + "b" * 40
        with self.assertRaisesRegex(ValueError, "Missing Infisical"):
            module.update_web_image(self.base, tag, {})
        bad = {"spec": {**self.base["spec"], "services": self.base["spec"]["services"][:-1]}}
        with self.assertRaisesRegex(ValueError, "topology changed"):
            module.update_web_image(bad, tag)
        with self.assertRaisesRegex(ValueError, "commit SHA"):
            module.update_web_image(self.base, "latest")
        legacy = {"spec": {**self.base["spec"], "jobs": [{"name": "web-migrate"}, {"name": "social-migrate"}]}}
        with self.assertRaisesRegex(ValueError, "Deploy the backend first"):
            module.update_web_image(legacy, tag)

    def test_supports_retired_storage_and_single_migration_job(self):
        cleaned = {"spec": {**self.base["spec"],
            "services": [item for item in self.base["spec"]["services"] if item["name"] != "storage"],
            "jobs": [self.base["spec"]["jobs"][0]],
        }}
        result = module.update_web_image(cleaned, "web-" + "b" * 40)
        self.assertEqual({item["name"] for item in result["services"]}, {"web", "screenshot-studio-backend"})
        self.assertEqual(result["jobs"], cleaned["spec"]["jobs"])
