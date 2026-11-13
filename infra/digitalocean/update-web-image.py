#!/usr/bin/env python3
"""Update the live web image without replacing the app spec.

The web has no database; the backend image's platform-migrate job owns the schema.
"""

import argparse
import copy
import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

IMAGE = {"registry_type": "GHCR", "registry": "playbookmediallc", "repository": "screenshot-studio"}
SERVICES = {"web", "screenshot-studio-backend"}
# Designs render in Cloudflare Browser Rendering over CDP, not a render service.
RETIRED_SERVICES = {"design-renderer"}
RETIRED_WEB_KEYS = {"PLATFORM_RENDER_SERVICE_URL", "PLATFORM_RENDER_SERVICE_SECRET",
                    "SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "PLATFORM_SLACK_CALLBACK_URL",
                    "PLATFORM_NOTIFICATION_ENCRYPTION_KEY"}
# Deployed by the backend workflow when its secrets are set (RFC 013).
OPTIONAL_SERVICES = {"collab", "storage"}
JOBS = {"platform-migrate"}
LEGACY_JOBS = {"social-migrate", "postiz-migrate"}
# Self-serve billing (docs/rfcs/035). Each key joins the web once it is in Infisical,
# so a deploy before Stripe is wired keeps checkout on the contact page.
STRIPE_SECRET_KEYS = ("STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET")
STRIPE_PRICE_KEYS = ("STRIPE_PRICE_PRO_MONTHLY", "STRIPE_PRICE_PRO_ANNUAL", "STRIPE_PRICE_BUSINESS_MONTHLY",
                     "STRIPE_PRICE_BUSINESS_ANNUAL", "STRIPE_PRICE_EXTRA_LAUNCH")
# The composer's Google Drive import. The Picker keys reach the browser, so they
# are plain settings that follow Infisical: removing them turns the import off.
GOOGLE_PICKER_KEYS = ("GOOGLE_PICKER_API_KEY", "GOOGLE_PICKER_APP_ID", "GOOGLE_PICKER_CLIENT_ID")
# The web reaches data and storage only through the backend.
WEB_DATABASE_KEYS = {"DATABASE_URL", "DIRECT_URL", "MIGRATION_DATABASE_URL", "AUDIT_RETENTION_DATABASE_URL",
                     "STORAGE_SERVICE_KEY", "STORAGE_API_URL", "STORAGE_PROXY_URL", "STORAGE_BUCKET",
                     "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ACCOUNT_ID", "R2_BUCKET_NAME", "R2_ENDPOINT", "R2_REGION",
                     "SOCIAL_API_URL", "SOCIAL_API_KEY"}


def configure_content_drafts(web_envs, secrets, collab_deployed):
    """Content drafts and co-editing (RFC 013), switched on from Infisical.

    PLATFORM_CONTENT_DRAFTS mirrors its Infisical value. The composer joins
    live sessions at wss://<origin>/collab once the backend deploy has added
    the collab service.
    """
    web_envs[:] = [item for item in web_envs if item["key"] not in ("PLATFORM_CONTENT_DRAFTS", "PLATFORM_COLLAB_URL")]
    if secrets.get("PLATFORM_CONTENT_DRAFTS"):
        web_envs.append({"key": "PLATFORM_CONTENT_DRAFTS", "value": secrets["PLATFORM_CONTENT_DRAFTS"],
                         "type": "GENERAL", "scope": "RUN_TIME"})
    origin = urlsplit(secrets.get("BETTER_AUTH_URL") or "").netloc
    if collab_deployed and origin:
        web_envs.append({"key": "PLATFORM_COLLAB_URL", "value": f"wss://{origin}/collab",
                         "type": "GENERAL", "scope": "RUN_TIME"})


def update_web_image(base, tag, secrets=None):
    if not re.fullmatch(r"web-[0-9a-f]{40}", tag):
        raise ValueError("Expected a unique web-<commit SHA> image tag")
    if isinstance(base, list):
        if len(base) != 1:
            raise ValueError("Expected one DigitalOcean app")
        base = base[0]
    spec = copy.deepcopy(base.get("spec", base))
    services = {item["name"]: item for item in spec["services"]}
    jobs = {item["name"]: item for item in spec.get("jobs", [])}
    if "web-migrate" in jobs:
        raise ValueError("Deploy the backend first; its platform-migrate job replaces web-migrate")
    if set(services) - RETIRED_SERVICES - OPTIONAL_SERVICES != SERVICES or set(jobs) - LEGACY_JOBS != JOBS:
        raise ValueError("Production topology changed; inspect the app before updating web")

    web = services["web"]
    current = web.get("image", {})
    if any(current.get(key) != value for key, value in IMAGE.items()):
        raise ValueError("web image source changed")
    web["image"] = dict(IMAGE, tag=tag)

    spec["services"] = [item for item in spec["services"] if item["name"] not in RETIRED_SERVICES]
    web_envs = web["envs"] = [item for item in web.get("envs", [])
                              if item["key"] not in WEB_DATABASE_KEYS | RETIRED_WEB_KEYS]
    if secrets is not None:
        if not secrets.get("PLATFORM_RENDER_CDP_URL"):
            raise ValueError("Missing Infisical secret: PLATFORM_RENDER_CDP_URL")
        web_envs[:] = [item for item in web_envs if not item["key"].startswith("PLATFORM_RENDER_CDP_")]
        web_envs += [{"key": "PLATFORM_RENDER_CDP_URL", "value": secrets["PLATFORM_RENDER_CDP_URL"],
                      "type": "GENERAL", "scope": "RUN_TIME"},
                     # Filled from Infisical with the other secrets below.
                     {"key": "PLATFORM_RENDER_CDP_TOKEN", "value": "", "type": "SECRET", "scope": "RUN_TIME"}]
        configure_content_drafts(web_envs, secrets, "collab" in services)
        # Password sign-in follows Infisical. An unset value keeps the live one,
        # because the web treats a missing variable as password sign-in on.
        if secrets.get("AUTH_ENABLE_PASSWORD"):
            web_envs[:] = [item for item in web_envs if item["key"] != "AUTH_ENABLE_PASSWORD"]
            web_envs.append({"key": "AUTH_ENABLE_PASSWORD", "value": secrets["AUTH_ENABLE_PASSWORD"],
                             "type": "GENERAL", "scope": "RUN_TIME"})
        for key in (key for key in STRIPE_SECRET_KEYS + STRIPE_PRICE_KEYS if secrets.get(key)):
            web_envs[:] = [item for item in web_envs if item["key"] != key]
            web_envs.append({"key": key, "value": secrets[key], "scope": "RUN_TIME",
                             "type": "SECRET" if key in STRIPE_SECRET_KEYS else "GENERAL"})
        web_envs[:] = [item for item in web_envs if item["key"] not in GOOGLE_PICKER_KEYS]
        web_envs += [{"key": key, "value": secrets[key], "type": "GENERAL", "scope": "RUN_TIME"}
                     for key in GOOGLE_PICKER_KEYS if secrets.get(key)]
    source = next((item for item in web_envs if item["key"] == "CLIENT_IP_SOURCE"), None)
    if source is None:
        web_envs.append({"key": "CLIENT_IP_SOURCE", "value": "digitalocean",
                         "type": "GENERAL", "scope": "RUN_TIME"})
    else:
        source["value"] = "digitalocean"

    if secrets is not None:
        # Telemetry settings are optional: one removed from Infisical leaves the
        # web, which turns telemetry off instead of failing the deploy.
        web_envs[:] = [item for item in web_envs if not (
            item["key"].startswith("OTEL_") and item.get("type") == "SECRET" and not secrets.get(item["key"]))]
        for item in web_envs:
            if item.get("type") != "SECRET":
                continue
            if not secrets.get(item["key"]):
                raise ValueError(f"Missing Infisical secret: {item['key']}")
            item["value"] = secrets[item["key"]]
    return spec


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--from-infisical-env", action="store_true")
    args = parser.parse_args()
    spec = update_web_image(json.loads(args.base.read_text()), args.tag,
                            dict(os.environ) if args.from_infisical_env else None)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with os.fdopen(os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as output:
        os.fchmod(output.fileno(), 0o600)
        json.dump(spec, output)
    print("Prepared web image update")


if __name__ == "__main__":
    main()
