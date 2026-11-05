#!/usr/bin/env python3
"""Deploy a new backend image to the production spec.

The input is a fresh `doctl apps get -o json` export. Keep input and output
private: both contain App Platform encrypted secret values.
"""

import argparse
import copy
import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

BACKEND = "screenshot-studio-backend"
MIGRATION_JOB = "platform-migrate"
RETIRED_BACKEND_KEYS = {"TENANT_STORAGE_SERVICE_KEY", "TENANT_STORAGE_API_URL", "TENANT_STORAGE_BUCKET"}
# The social API process is gone: the product API connects channels and serves
# MCP in process. Its own database, Redis, Temporal and listener settings are
# unused. JWT_SECRET, provider credentials and storage settings stay; the
# product API reads them.
RETIRED_SOCIAL_KEYS = {"DATABASE_URL", "REDIS_URL", "TEMPORAL_ADDRESS", "TEMPORAL_NAMESPACE", "TEMPORAL_API_KEY",
                       "TEMPORAL_TLS", "TEMPORAL_SOCIAL_TASK_QUEUE", "PORT", "ORCHESTRATOR_PORT", "RUN_WORKER",
                       "RUN_CRON", "BACKEND_INTERNAL_URL", "MAIN_URL", "NEXT_PUBLIC_BACKEND_URL",
                       "TENANT_SOCIAL_API_URL"}
IMAGE = {"registry_type": "GHCR", "registry": "playbookmediallc", "repository": "screenshot-studio"}
SOCIAL_SECRET_SOURCES = {
    "JWT_SECRET": "SOCIAL_JWT_SECRET",
    "X_API_KEY": "SOCIAL_X_API_KEY",
    "X_API_SECRET": "SOCIAL_X_API_SECRET",
    "FACEBOOK_APP_ID": "SOCIAL_FACEBOOK_APP_ID",
    "FACEBOOK_APP_SECRET": "SOCIAL_FACEBOOK_APP_SECRET",
    "INSTAGRAM_APP_ID": "SOCIAL_INSTAGRAM_APP_ID",
    "INSTAGRAM_APP_SECRET": "SOCIAL_INSTAGRAM_APP_SECRET",
    "THREADS_APP_ID": "SOCIAL_THREADS_APP_ID",
    "THREADS_APP_SECRET": "SOCIAL_THREADS_APP_SECRET",
}
OPTIONAL_SOCIAL_SECRETS = (
    "PLATFORM_SOCIAL_ENCRYPTION_PREVIOUS_KEY",
    "LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET", "X_API_KEY", "X_API_SECRET",
    "PLATFORM_LINKEDIN_PAGE_CLIENT_ID", "PLATFORM_LINKEDIN_PAGE_CLIENT_SECRET",
    "TIKTOK_CLIENT_ID", "TIKTOK_CLIENT_SECRET", "YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET",
    "FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET", "INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET",
    "THREADS_APP_ID", "THREADS_APP_SECRET",
    # Keeps a provider "Coming soon" while its credentials are deployed for review.
    "HIDDEN_PROVIDERS",
    # The workspaces, such as an app reviewer's, that can still connect them.
    "PLATFORM_SOCIAL_HIDDEN_PROVIDER_WORKSPACES",
)
# The onboarding agent's model and enrichment (docs/rfcs/032); without them it
# drafts from page metadata and skips Exa.
OPTIONAL_TENANT_SECRETS = (
    "OPENROUTER_API_KEY", "PLATFORM_ENRICHMENT_EXA_API_KEY",
    "PLATFORM_NOTIFICATION_ENCRYPTION_KEY", "SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET",
    "PLATFORM_SLACK_CALLBACK_URL", "INTEGRATION_ENCRYPTION_KEY",
    # Outbound webhooks (docs/rfcs/043); without it the API answers 503.
    "PLATFORM_WEBHOOK_ENCRYPTION_KEY",
    # Authenticated capture; without all three it stays off. The token is separate
    # from the design renderer's and never reaches the web.
    "PLATFORM_CAPTURE_CDP_URL", "PLATFORM_CAPTURE_CDP_TOKEN", "PLATFORM_CAPTURE_STATE_KEY",
    "PLATFORM_CAPTURE_STATE_KEY_PREVIOUS", "PLATFORM_CAPTURE_STATE_MAX_AGE",
)
# OpenTelemetry export to Axiom (docs/observability.md). The headers carry the
# Axiom token. The backend and the web read the same keys.
TELEMETRY_SETTINGS = ("OTEL_ENABLED", "OTEL_SAMPLING_RATE", "OTEL_EXPORTER_OTLP_ENDPOINT",
                      "OTEL_EXPORTER_OTLP_TRACES_HEADERS", "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
                      "OTEL_RESOURCE_ATTRIBUTES", "OTEL_PROMOTED_SPANS_PER_SECOND",
                      "OTEL_SLOW_SPAN_THRESHOLD", "OTEL_BSP_MAX_QUEUE_SIZE")
OPTIONAL_TENANT_SECRETS += TELEMETRY_SETTINGS
OPTIONAL_TENANT_KEYS = {"TENANT_" + key for key in OPTIONAL_TENANT_SECRETS}


# cutover: the live spec and Infisical still hold the legacy prefix. Each deploy
# moves both to the social names; delete this once Infisical and the live app
# are moved.
LEGACY_PREFIXES = (("POSTIZ_GO_", "SOCIAL_"), ("POSTIZ_", "SOCIAL_"))
LEGACY_MIGRATION_JOB = "postiz-migrate"
LEGACY_TASK_QUEUE = "postiz"


def social_name(key):
    for legacy, name in LEGACY_PREFIXES:
        if legacy in key:
            return key.replace(legacy, name, 1)
    return key


def move_legacy_names(spec, secrets):
    if secrets is not None:
        for key, value in list(secrets.items()):
            secrets.setdefault(social_name(key), value)
    for component in spec.get("services", []) + spec.get("jobs", []):
        envs = component.get("envs", [])
        for item in envs:
            item["key"] = social_name(item["key"])
        # The default queue is social now; an override of the legacy one would pin it.
        envs[:] = [item for item in envs if (item["key"], item.get("value")) != (
            "TEMPORAL_SOCIAL_TASK_QUEUE", LEGACY_TASK_QUEUE)]


def set_env(envs, key, value):
    for item in envs:
        if item["key"] == key:
            item["value"] = value
            return
    envs.append({"key": key, "value": value, "type": "GENERAL", "scope": "RUN_TIME"})


def set_secret_env(envs, key, value):
    for item in envs:
        if item["key"] == key:
            item.update(value=value, type="SECRET", scope="RUN_TIME")
            return
    envs.append({"key": key, "value": value, "type": "SECRET", "scope": "RUN_TIME"})


def publishing_token(services, secrets):
    if secrets is not None and secrets.get("PUBLISHING_SERVICE_TOKEN"):
        return secrets["PUBLISHING_SERVICE_TOKEN"]
    for name in (BACKEND, "publishing-backend"):
        for item in services.get(name, {}).get("envs", []):
            if item["key"] in ("TENANT_PUBLISHING_SERVICE_TOKEN", "PUBLISHING_SERVICE_TOKEN"):
                return item["value"]
    raise ValueError("PUBLISHING_SERVICE_TOKEN is required for the Ent publishing API")


def configure_publishing_api(backend, web, token, direct_enabled=False):
    set_secret_env(backend["envs"], "TENANT_PUBLISHING_SERVICE_TOKEN", token)
    set_env(backend["envs"], "TENANT_PUBLISHING_DIRECT_PROVIDER", "true" if direct_enabled else "false")
    if direct_enabled:
        social = {item["key"]: item for item in backend["envs"]}
        for key in ("SOCIAL_PRIVATE_MEDIA", "STORAGE_PROVIDER", "CLOUDFLARE_ACCOUNT_ID",
                    "CLOUDFLARE_BUCKETNAME", "CLOUDFLARE_BUCKET_URL", "CLOUDFLARE_ACCESS_KEY",
                    "CLOUDFLARE_SECRET_ACCESS_KEY"):
            if key not in social:
                raise ValueError(f"Direct publishing requires {key}")
            value = social[key]["value"]
            if social[key].get("type") == "SECRET":
                set_secret_env(backend["envs"], "TENANT_" + key, value)
            else:
                set_env(backend["envs"], "TENANT_" + key, value)
    backend["internal_ports"] = [3003, 8082]
    # The web reaches all data through the backend.
    set_env(web["envs"], "PUBLISHING_API_URL", f"http://{BACKEND}:8082")
    set_secret_env(web["envs"], "PUBLISHING_SERVICE_TOKEN", token)


def configure_product_api(backend, secrets):
    """The product API signs R2 transfers and counts workspace quotas in Redis."""
    if secrets is None:
        return
    for key in ("R2_ENDPOINT", "R2_BUCKET_NAME", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "REDIS_URL"):
        if not secrets.get(key):
            raise ValueError(f"Missing Infisical secret: {key}")
    set_env(backend["envs"], "TENANT_R2_ENDPOINT", secrets["R2_ENDPOINT"])
    set_env(backend["envs"], "TENANT_R2_BUCKET_NAME", secrets["R2_BUCKET_NAME"])
    set_env(backend["envs"], "TENANT_R2_REGION", secrets.get("R2_REGION") or "auto")
    for key in ("R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "REDIS_URL"):
        set_secret_env(backend["envs"], "TENANT_" + key, secrets[key])
    backend["envs"][:] = [item for item in backend["envs"] if item["key"] not in OPTIONAL_TENANT_KEYS]
    for key in OPTIONAL_TENANT_SECRETS:
        if secrets.get(key):
            set_secret_env(backend["envs"], "TENANT_" + key, secrets[key])


def configure_telemetry(web, secrets):
    """The web exports to Axiom with the backend's telemetry settings, gzipped."""
    if secrets is None:
        return
    keys = set(TELEMETRY_SETTINGS) | {"OTEL_EXPORTER_OTLP_COMPRESSION"}
    web["envs"][:] = [item for item in web["envs"] if item["key"] not in keys]
    for key in TELEMETRY_SETTINGS:
        if secrets.get(key):
            set_secret_env(web["envs"], key, secrets[key])
    if secrets.get("OTEL_ENABLED"):
        set_env(web["envs"], "OTEL_EXPORTER_OTLP_COMPRESSION", "gzip")


def refresh_secrets(envs, secrets):
    if secrets is None:
        return
    for item in envs:
        if item.get("type") != "SECRET":
            continue
        key = item["key"]
        if key in OPTIONAL_SOCIAL_SECRETS or key in OPTIONAL_TENANT_KEYS:
            continue
        source = key.removeprefix("TENANT_") if key.startswith("TENANT_") else SOCIAL_SECRET_SOURCES.get(key, key)
        if not secrets.get(source):
            raise ValueError(f"Missing Infisical secret: {source}")
        item["value"] = secrets[source]


def platform_migration(spec, image, secrets=None):
    """One Go job applies both product and social migrations with the DDL owner."""
    names = (MIGRATION_JOB, "web-migrate", "social-migrate", LEGACY_MIGRATION_JOB)
    previous = next((item for name in names for item in spec.get("jobs", []) if item["name"] == name), None)
    if previous is None:
        raise ValueError("Platform migration job is missing")
    database = (secrets.get("MIGRATION_DATABASE_URL") if secrets is not None else
                next((item["value"] for item in previous.get("envs", []) if item["key"] == "DATABASE_URL"), None))
    if not database:
        raise ValueError("MIGRATION_DATABASE_URL is required for the platform migration")
    job = dict(copy.deepcopy(previous), name=MIGRATION_JOB, image=copy.deepcopy(image),
               run_command="/platform-migrate", kind="PRE_DEPLOY",
               envs=[{"key": "DATABASE_URL", "value": database, "type": "SECRET", "scope": "RUN_TIME"}])
    spec["jobs"] = [job if item is previous else item for item in spec["jobs"]
                    if item is previous or item["name"] not in names]


def add_optional_social_secrets(envs, secrets):
    if secrets is None:
        return
    envs[:] = [item for item in envs if item["key"] not in OPTIONAL_SOCIAL_SECRETS or
               secrets.get(SOCIAL_SECRET_SOURCES.get(item["key"], item["key"]))]
    existing = {item["key"]: item for item in envs}
    for key in OPTIONAL_SOCIAL_SECRETS:
        if value := secrets.get(SOCIAL_SECRET_SOURCES.get(key, key)):
            item = existing.get(key)
            if item is None:
                envs.append({"key": key, "value": value, "type": "SECRET", "scope": "RUN_TIME"})
            else:
                item.update(value=value, type="SECRET", scope="RUN_TIME")


def configure_social_credentials(envs, secrets):
    key = "PLATFORM_SOCIAL_ENCRYPTION_KEY"
    if secrets is not None:
        if not secrets.get(key):
            raise ValueError("PLATFORM_SOCIAL_ENCRYPTION_KEY must be configured before deploying social credentials")
        set_secret_env(envs, key, secrets[key])
    elif not any(item["key"] == key and item.get("value") and item.get("type") == "SECRET" for item in envs):
        raise ValueError("PLATFORM_SOCIAL_ENCRYPTION_KEY must be configured before deploying social credentials")


COLLAB = "collab"
COLLAB_SECRETS = ("COLLAB_TOKEN_SECRET", "COLLAB_SERVICE_TOKEN")


def collaboration_enabled(secrets):
    """Content draft co-editing (RFC 013) ships once both secrets are in Infisical."""
    return secrets is not None and all(secrets.get(key) for key in COLLAB_SECRETS)


def configure_collab(spec, backend, secrets, collab_tag):
    """Run the collab service beside the backend, or remove it.

    Only the backend holds the signing key. The collab service gets its own
    credential, which opens only the backend's collaboration routes, and no
    database or Redis setting. Browsers reach it at /collab.
    """
    keys = {"TENANT_" + key for key in COLLAB_SECRETS}
    backend["envs"] = [item for item in backend["envs"] if item["key"] not in keys]
    spec["services"] = [item for item in spec["services"] if item["name"] != COLLAB]
    rules = spec.setdefault("ingress", {}).setdefault("rules", [])
    rules[:] = [rule for rule in rules if rule.get("component", {}).get("name") != COLLAB]
    if not collaboration_enabled(secrets) or collab_tag is None:
        return
    for key in COLLAB_SECRETS:
        set_secret_env(backend["envs"], "TENANT_" + key, secrets[key])
    # Replicas relay live edits through Redis (the Hocuspocus Redis
    # extension); without COLLAB_REDIS_URL there is one instance.
    instances = int(secrets.get("COLLAB_INSTANCE_COUNT") or 1)
    if instances < 1 or (instances > 1 and not secrets.get("COLLAB_REDIS_URL")):
        raise ValueError("COLLAB_INSTANCE_COUNT above 1 needs COLLAB_REDIS_URL")
    redis = ([{"key": "COLLAB_REDIS_URL", "value": secrets["COLLAB_REDIS_URL"], "type": "SECRET",
               "scope": "RUN_TIME"}] if secrets.get("COLLAB_REDIS_URL") else [])
    spec["services"].append({
        "name": COLLAB,
        "image": dict(IMAGE, tag=collab_tag),
        "instance_count": instances,
        "instance_size_slug": "apps-s-1vcpu-0.5gb",
        "http_port": 1234,
        "health_check": {"http_path": "/health", "port": 1234, "initial_delay_seconds": 10,
                         "period_seconds": 15, "timeout_seconds": 5, "failure_threshold": 6},
        "envs": [
            {"key": "COLLAB_BACKEND_URL", "value": f"http://{BACKEND}:8082", "type": "GENERAL", "scope": "RUN_TIME"},
            {"key": "COLLAB_SERVICE_TOKEN", "value": secrets["COLLAB_SERVICE_TOKEN"], "type": "SECRET",
             "scope": "RUN_TIME"},
        ] + redis,
    })
    # The prefix is stripped before Hocuspocus sees the request.
    rules.insert(0, {"match": {"path": {"prefix": "/collab"}}, "component": {"name": COLLAB}})


# The paths the MCP server and its OAuth flow serve (RFC 026).
MCP_PATH_PREFIXES = ("/mcp", "/mcp-oauth-claude", "/mcp-oauth-chatgpt", "/mcp-oauth-dynamic", "/.well-known", "/oauth")


def is_mcp_rule(rule):
    return rule.get("component", {}).get("name") == BACKEND and bool(
        rule.get("match", {}).get("authority", {}).get("exact"))


def configure_mcp(spec, backend, web, secrets):
    """Serve the MCP server (RFC 026) at PLATFORM_MCP_URL, or remove it.

    OAuth discovery reads metadata from the host root, so the URL must be
    https://<host>/mcp on a host of its own. On that host only, the MCP and
    OAuth paths reach the backend ahead of the web. The host is an alias
    domain; its CNAME points at the app's default domain.
    """
    if secrets is None:
        return
    url = secrets.get("PLATFORM_MCP_URL") or ""
    parts = urlsplit(url)
    if url and (parts.scheme != "https" or not parts.hostname or parts.path != "/mcp"):
        raise ValueError("PLATFORM_MCP_URL must be https://<host>/mcp, at the root of its own host")
    rules = spec.setdefault("ingress", {}).setdefault("rules", [])
    previous = {rule["match"]["authority"]["exact"] for rule in rules if is_mcp_rule(rule)}
    rules[:] = [rule for rule in rules if not is_mcp_rule(rule)]
    spec["domains"] = [item for item in spec.get("domains", []) if item["domain"] not in previous]
    for service in (backend, web):
        service["envs"] = [item for item in service["envs"] if item["key"] != "PLATFORM_MCP_URL"]
    if not url:
        return
    for service in (backend, web):
        set_env(service["envs"], "PLATFORM_MCP_URL", url)
    for prefix in reversed(MCP_PATH_PREFIXES):
        rules.insert(0, {"match": {"authority": {"exact": parts.hostname}, "path": {"prefix": prefix}},
                         "component": {"name": BACKEND, "preserve_path_prefix": True}})
    spec["domains"].append({"domain": parts.hostname, "type": "ALIAS"})


def consolidate(base, digest, secrets=None, tag=None, collab_tag=None):
    if not digest.startswith("sha256:") or len(digest) != 71:
        raise ValueError("Expected an immutable SHA-256 image digest")
    if tag is not None and not re.fullmatch(r"social-backend-[0-9a-f]{40}", tag):
        raise ValueError("Expected a commit SHA image tag")
    if collab_tag is not None and not re.fullmatch(r"collab-[0-9a-f]{40}", collab_tag):
        raise ValueError("Expected a collab-<commit SHA> image tag")
    image = dict(IMAGE, **({"tag": tag} if tag else {"digest": digest}))
    if isinstance(base, list):
        if len(base) != 1:
            raise ValueError("Expected one DigitalOcean app")
        base = base[0]
    spec = copy.deepcopy(base.get("spec", base))
    move_legacy_names(spec, secrets)
    services = {item["name"]: item for item in spec["services"]}
    # The web deploy retires design-renderer; both shapes are current.
    if set(services) - {"storage", "design-renderer", COLLAB} != {"web", BACKEND}:
        raise ValueError("Production topology changed; inspect the app before deploying")
    spec["services"] = [item for item in spec["services"] if item["name"] != "storage"]
    rules = spec.setdefault("ingress", {}).setdefault("rules", [])
    rules[:] = [rule for rule in rules if rule.get("component", {}).get("name") != "storage"
                and rule.get("match", {}).get("path", {}).get("prefix") != "/postiz"]
    backend = services[BACKEND]
    retired = RETIRED_BACKEND_KEYS | RETIRED_SOCIAL_KEYS
    backend["envs"] = [item for item in backend["envs"] if item["key"] not in retired]
    web = services["web"]
    web["envs"] = [item for item in web.get("envs", []) if item["key"] != "SOCIAL_API_URL"]
    if backend.get("image", {}).get("registry_type") != "GHCR":
        raise ValueError("Combined backend image source changed")
    configure_collab(spec, backend, secrets, collab_tag)
    configure_mcp(spec, backend, services["web"], secrets)
    refresh_secrets(backend["envs"], secrets)
    add_optional_social_secrets(backend["envs"], secrets)
    configure_social_credentials(backend["envs"], secrets)
    configure_publishing_api(backend, services["web"], publishing_token(services, secrets),
                             secrets is not None and secrets.get("ENABLE_DIRECT_PROVIDER") == "true")
    configure_product_api(backend, secrets)
    configure_telemetry(services["web"], secrets)
    backend["image"] = image
    platform_migration(spec, image, secrets)
    return spec


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--digest", required=True)
    parser.add_argument("--tag", help="Unique social-backend-<commit SHA> tag to deploy")
    parser.add_argument("--collab-tag", help="collab-<commit SHA> tag of the collaboration server")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--from-infisical-env", action="store_true",
                        help="Use OIDC-loaded Infisical values for the new backend secrets")
    args = parser.parse_args()
    spec = consolidate(json.loads(args.base.read_text()), args.digest,
                       dict(os.environ) if args.from_infisical_env else None, args.tag, args.collab_tag)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with os.fdopen(os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as output:
        os.fchmod(output.fileno(), 0o600)
        json.dump(spec, output)
    print(f"Prepared {len(spec['services'])} services and {len(spec['jobs'])} jobs")


if __name__ == "__main__":
    main()
